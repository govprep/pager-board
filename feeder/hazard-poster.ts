import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "../lib/supabase-server";
import type { Hazard, HazardCategory } from "../lib/hazards";

// ---------------------------------------------------------------------------
// The hazard writer — the counterpart to feeder/poster.ts, and deliberately a
// separate one.
//
// Nothing here goes near writeBoard(). No board filter, no stand-downs, no
// fire-weather attach, no Slack, no push. That is the entire point: a hazard
// must not be able to reach a phone, and the cheapest guarantee of that is a
// code path with no phone in it.
// ---------------------------------------------------------------------------

// How long a hazard may go unseen before an empty poll is allowed to close it.
// Three times the slowest poll (15 min), so a single failed request — or two —
// never ends a roadwork that is still there.
const STALE_MS = 45 * 60_000;

export type HazardPostFn = (
  hazards: Hazard[],
  source: string,
  category: HazardCategory,
) => Promise<void>;

export interface HazardWriter {
  post: HazardPostFn;
}

interface HazardRow {
  id: string;
  source: string;
  external_id: string;
  category: string;
  headline: string;
  display_name: string;
  advice: string;
  is_major: boolean;
  suburb: string | null;
  coords: { lng: number; lat: number } | null;
  geometry: unknown;
  roads: unknown;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  url: string | null;
  raw: unknown;
  last_seen_at: string;
}

function toRow(h: Hazard, seenAt: string): HazardRow {
  return {
    id: h.id,
    source: h.source,
    external_id: h.externalId,
    category: h.category,
    headline: h.headline,
    display_name: h.displayName,
    advice: h.advice,
    is_major: h.isMajor,
    suburb: h.suburb,
    coords: h.coords,
    geometry: h.geometry,
    roads: h.roads,
    started_at: h.startedAt,
    updated_at: h.updatedAt,
    ended_at: h.endedAt,
    url: h.url,
    raw: h.raw,
    last_seen_at: seenAt,
  };
}

export function makeHazardWriter(): HazardWriter {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }

  const db: SupabaseClient = createServerClient(url, key);

  async function post(hazards: Hazard[], source: string, category: HazardCategory) {
    const seenAt = new Date().toISOString();

    if (hazards.length) {
      const { error } = await db
        .from("hazards")
        .upsert(hazards.map((h) => toRow(h, seenAt)), { onConflict: "id" });
      if (error) {
        console.error(`[hazards:${category}]`, error.message);
        return;
      }
    }

    // Close what has left the feed.
    //
    // A hazard does not announce its own end: it is in /open one minute and
    // absent the next, and absence is the only signal there is. Each poll is a
    // full picture of one category, so "not in this poll" means over.
    //
    // Expressed as `last_seen_at < seenAt` rather than an id list, because the
    // upsert above has just stamped every hazard we saw with exactly `seenAt` —
    // which makes the ones we didn't see precisely the rows still carrying an
    // older stamp. The id-list form would have to interpolate feed-supplied
    // strings into a PostgREST filter, and those ids are someone else's to
    // choose.
    if (hazards.length) {
      const { error } = await db
        .from("hazards")
        .update({ ended_at: seenAt })
        .eq("source", source)
        .eq("category", category)
        .is("ended_at", null)
        .lt("last_seen_at", seenAt);
      if (error) console.error(`[hazards:${category}] close:`, error.message);
      return;
    }

    // An empty response is ambiguous: a genuinely quiet category looks exactly
    // like a request that returned nothing useful, and closing every open
    // hazard on the strength of one bad response is the mistake that shows on
    // the map. So an empty poll closes only what has been missing long enough
    // that no single failure explains it — comfortably longer than the slowest
    // category's interval, and the only path that can close a hazard without a
    // successful poll to compare against.
    const stale = new Date(Date.now() - STALE_MS).toISOString();
    const { error } = await db
      .from("hazards")
      .update({ ended_at: seenAt })
      .eq("source", source)
      .eq("category", category)
      .is("ended_at", null)
      .lt("last_seen_at", stale);

    if (error) console.error(`[hazards:${category}] sweep:`, error.message);
  }

  return { post };
}
