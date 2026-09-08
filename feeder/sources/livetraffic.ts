import {
  inArea,
  representativePoint,
  text,
  toIso,
  type Hazard,
  type HazardCategory,
} from "../../lib/hazards";
import type { HazardPostFn } from "../hazard-poster";

// ---------------------------------------------------------------------------
// Live Traffic NSW — Transport for NSW's open hazard feed.
//
//   https://api.transport.nsw.gov.au/v1/live/hazards/{category}/{all|open|closed}
//
// A free key from the TfNSW Open Data Hub, sent as `Authorization: apikey KEY`.
// The licence is CC-BY: wherever these are drawn, Transport for NSW has to be
// named. That attribution lives with the map layer, not here.
//
// This is the only source of hazards today. Everything shaped by *this* feed
// stops at this file — lib/hazards.ts and the writer below know nothing about
// Live Traffic's field names, so a second publisher is a second file like this
// one rather than a change to any of that.
// ---------------------------------------------------------------------------

const BASE = "https://api.transport.nsw.gov.au/v1/live/hazards";

// Split by how fast each category can change under you.
//
// A crash matters in the minutes it is happening and is gone within the hour;
// a roadwork is a fact about next month that we are reading because a truck has
// to get past it tonight. Polling both at a crash's cadence would be ~1400
// pointless requests a day against someone else's free tier.
const FAST: HazardCategory[] = ["incident", "fire", "flood"];
const SLOW: HazardCategory[] = ["roadwork", "majorevent", "alpine"];
const FAST_MS = 60_000;
const SLOW_MS = 15 * 60_000;

/** A GeoJSON feature as the feed publishes it — every field optional to us. */
interface Feature {
  geometry?: unknown;
  properties?: Record<string, unknown>;
}

/**
 * The field mapping, written from the published Live Traffic developer guide.
 *
 * Every read here is defensive and the whole feature is kept in `raw`, because
 * this mapping has not yet been run against a live key — see the note in
 * docs/hazards.md. If a name below turns out to be wrong, the fix is this
 * function and a re-poll, with no data lost in the meantime.
 */
export function toHazard(
  feature: Feature,
  category: HazardCategory,
  now = new Date().toISOString(),
): Hazard | null {
  const p = feature.properties ?? {};
  const externalId = text(p.id) || text(p.hazardId);
  if (!externalId) return null;

  const geometry = feature.geometry ?? null;
  const roads = Array.isArray(p.roads) ? p.roads : [];
  const firstRoad = (roads[0] ?? {}) as Record<string, unknown>;

  // The feed carries advice in several optional fields; a hazard usually fills
  // one or two of them. Joined rather than picked, because which one is used
  // varies by category — "otherAdvice" on a roadwork, "adviceA"/"adviceB" on a
  // crash — and a card showing the wrong empty one says nothing.
  const advice = [p.adviceA, p.adviceB, p.otherAdvice, p.additionalInfo]
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map(text)
    .filter(Boolean)
    .join(" ");

  const started = toIso(p.start) ?? toIso(p.created);
  const updated = toIso(p.lastUpdated) ?? started;

  // `isEnded` is the feed's own flag; `end` is when it says it finished. A
  // hazard pulled from /open should carry neither, but /all carries both and
  // the writer needs the distinction to close a row.
  const ended = p.isEnded === true ? toIso(p.end) ?? updated ?? now : null;

  return {
    id: `livetraffic|${externalId}`,
    source: "livetraffic",
    externalId,
    category,
    headline: text(p.headline) || text(p.displayName) || category,
    displayName: text(p.displayName) || text(firstRoad.mainStreet),
    advice,
    isMajor: p.isMajor === true,
    suburb: text(firstRoad.suburb) || null,
    coords: representativePoint(geometry),
    geometry,
    roads,
    startedAt: started ?? now,
    updatedAt: updated ?? started ?? now,
    endedAt: ended,
    url: text(p.webLinkUrl) || null,
    raw: feature,
  };
}

async function fetchCategory(category: HazardCategory, key: string): Promise<Hazard[]> {
  const res = await fetch(`${BASE}/${category}/open`, {
    headers: { Authorization: `apikey ${key}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${category}: HTTP ${res.status}`);

  const body = (await res.json()) as { features?: Feature[] };
  const features = Array.isArray(body.features) ? body.features : [];

  // Clipped here rather than in the writer so the cost of a statewide feed is
  // paid once, on the way in. `inArea` reads the geometry, not the suburb: a
  // closure whose line starts in Sydney and ends in Goulburn is ours.
  return features
    .filter((f) => inArea(f.geometry))
    .map((f) => toHazard(f, category))
    .filter((h): h is Hazard => h !== null);
}

/**
 * Poll every category, writing what falls inside the area. Silent no-op without
 * TFNSW_API_KEY, the same way the other optional sources disable themselves.
 */
export async function pollLiveTraffic(post: HazardPostFn): Promise<void> {
  const key = process.env.TFNSW_API_KEY ?? "";
  if (!key) {
    console.log("[livetraffic] TFNSW_API_KEY not set — skipping");
    return;
  }

  async function tick(categories: HazardCategory[]) {
    for (const category of categories) {
      try {
        const hazards = await fetchCategory(category, key);
        await post(hazards, "livetraffic", category);
      } catch (err) {
        // One category failing is not the others failing — a 503 on roadwork
        // must not cost us the crash feed.
        console.error("[livetraffic]", err instanceof Error ? err.message : err);
      }
    }
  }

  await tick(FAST);
  setInterval(() => void tick(FAST), FAST_MS);

  await tick(SLOW);
  setInterval(() => void tick(SLOW), SLOW_MS);
}
