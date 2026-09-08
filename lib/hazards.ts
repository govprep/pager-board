import type { Coords } from "./types";

// ---------------------------------------------------------------------------
// Hazards — road and area conditions, as opposed to pages.
//
// A hazard is not an incident and deliberately does not travel the incident
// path. `incidents` is keyed on the incident number, upserted by a merge that
// compares two decodes of the same page, cancelled by stand-downs, and fanned
// out to Slack and phones. A hazard has none of that shape:
//
//   · no incident number — its identity is the publisher's own id;
//   · a lifecycle measured in days, not minutes. It opens, is edited many
//     times, and closes. A roadwork runs for months;
//   · line geometry as often as a point — a closure is a stretch of road;
//   · volume that would bury the board, and must never reach a phone. Nobody
//     is woken at 2am for a lane closure on the Hume.
//
// So hazards get their own table, their own writer and their own map layer,
// and share with the board only the shape of the code. What they are *for* is
// the crew's question on the way out the door: what is between us and the job.
//
// This module is the source-agnostic middle. A source (lib is called by
// feeder/sources/livetraffic.ts today) hands it whatever its publisher
// returns; it hands back rows. Nothing here fetches.
// ---------------------------------------------------------------------------

/** Live Traffic's categories, which are also our own. */
export type HazardCategory =
  | "incident"
  | "fire"
  | "flood"
  | "roadwork"
  | "majorevent"
  | "alpine";

export interface Hazard {
  /** `{source}|{externalId}` — stable across every update of one hazard. */
  id: string;
  /** Which feed carried it, e.g. "livetraffic". */
  source: string;
  /** The publisher's own id for the hazard. */
  externalId: string;
  category: HazardCategory;
  /** One-line summary, e.g. "Crash", "Reduced speed limit". */
  headline: string;
  /** The roads it sits on, as the publisher names them. */
  displayName: string;
  /** Free-text advice, joined from whatever advice fields the feed carries. */
  advice: string;
  /** The publisher's own "this one matters" flag. */
  isMajor: boolean;
  suburb: string | null;
  /** A single point to hang proximity off — see representativePoint(). */
  coords: Coords | null;
  /** The geometry as published: Point, LineString, MultiLineString, Polygon. */
  geometry: unknown;
  /** Every road entry, kept whole for the card. */
  roads: unknown[];
  startedAt: string;
  updatedAt: string;
  /** Set once the hazard closes, or falls out of the feed's open list. */
  endedAt: string | null;
  /** A link back to the publisher's own page for it, when it has one. */
  url: string | null;
  /** The untouched feature, so a mapping fixed later needs no re-fetch. */
  raw: unknown;
}

// The area the brigade is paged to: Queanbeyan-Palerang, Yass Valley and
// Goulburn Mulwaree, with room around the edges (lib/area-channels.ts is the
// same area expressed as Slack routing). Live Traffic is a statewide feed —
// unclipped, it is several hundred Sydney roadworks and nothing you can use.
//
// west, south, east, north — the same order as lib/geocode.ts's BBOX, which is
// the whole of NSW and deliberately much larger: that one bounds a guess at a
// place name, this one decides what is worth storing at all.
const DEFAULT_BBOX: [number, number, number, number] = [148.55, -35.75, 150.35, -34.3];

/** `HAZARD_BBOX="west,south,east,north"` overrides the area above. */
export function areaBbox(): [number, number, number, number] {
  const raw = (process.env.HAZARD_BBOX ?? "").split(",").map(Number);
  if (raw.length === 4 && raw.every((n) => Number.isFinite(n))) {
    return [raw[0], raw[1], raw[2], raw[3]];
  }
  return DEFAULT_BBOX;
}

/** Every coordinate pair in a GeoJSON geometry, at any nesting depth. */
function* eachCoord(node: unknown): Generator<[number, number]> {
  if (!Array.isArray(node)) return;
  if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
    yield [node[0], node[1]];
    return;
  }
  for (const child of node) yield* eachCoord(child);
}

/**
 * One point for a hazard that may be a line or a polygon.
 *
 * The midpoint of the coordinate list rather than a true centroid: a road
 * closure is a stretch, and the middle of the stretch is both cheap and the
 * honest answer to "roughly where". A centroid of a long curved LineString can
 * land off the road entirely, which for a thing whose whole purpose is "is this
 * between us and the job" is worse than approximate.
 */
export function representativePoint(geometry: unknown): Coords | null {
  const g = geometry as { coordinates?: unknown } | null | undefined;
  const coords = [...eachCoord(g?.coordinates)];
  if (!coords.length) return null;
  const [lng, lat] = coords[Math.floor(coords.length / 2)];
  return { lng, lat };
}

/** True when any part of the geometry falls inside the area box. */
export function inArea(
  geometry: unknown,
  bbox: [number, number, number, number] = areaBbox(),
): boolean {
  const [west, south, east, north] = bbox;
  const g = geometry as { coordinates?: unknown } | null | undefined;
  for (const [lng, lat] of eachCoord(g?.coordinates)) {
    if (lng >= west && lng <= east && lat >= south && lat <= north) return true;
  }
  return false;
}

/**
 * A timestamp from a feed that has never committed to one format. Live Traffic
 * publishes epoch milliseconds; the guide shows ISO strings in places, and
 * seconds appear in older samples. Anything unreadable returns null rather than
 * a plausible-looking now(), which would date a hazard to the moment we happened
 * to poll.
 */
export function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Anything below this is seconds, not milliseconds: as ms it would be 1970.
    const ms = value < 100_000_000_000 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Trim a value a feed may have published as null, a number, or absent. */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
