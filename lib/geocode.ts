import type { Coords } from "./types";

// Turning place text into a point, in the browser.
//
// Two callers need it and neither can be served from the page data alone:
//   · the incident card, when a page arrived without coordinates but with an
//     address (components/IncidentMap.tsx);
//   · the live map, which has to put every FRNSW job somewhere — those pages
//     carry no address at all, only a station turnout, so the pin goes on the
//     station's suburb (components/LiveMap.tsx, lib/incident-points.ts).
//
// The live map is why this caches. A quiet four hours is a dozen suburbs; a busy
// one is fifty, re-asked on every reload, every window change and every return
// to the foreground — for names that do not move. Answers are kept for 30 days,
// which is the longest Mapbox's terms allow a temporary geocode to be held.

const CACHE_KEY = "belterhub.geocode.v1";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Entry = { lng: number; lat: number; at: number };

// Read once, then kept in memory: this is hit once per job per render pass, and
// re-parsing a few hundred KB of JSON on each of those is real work.
let cache: Map<string, Entry> | null = null;
// Queries already in flight, so a batch of jobs sharing a suburb — which is the
// normal shape of a FRNSW turnout — costs one request rather than one each.
const inFlight = new Map<string, Promise<Coords | null>>();
// Misses, remembered for this page only. A name Mapbox can't place won't be
// placeable on the next render either, and without this every failed lookup is
// retried forever. Not persisted: a miss can be a network blip.
const missed = new Set<string>();

function load(): Map<string, Entry> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const cutoff = Date.now() - TTL_MS;
      for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, Entry>)) {
        if (value?.at > cutoff && Number.isFinite(value.lng) && Number.isFinite(value.lat)) {
          cache.set(key, value);
        }
      }
    }
  } catch {
    // Private mode, disabled storage, or a corrupt blob — geocode fresh.
  }
  return cache;
}

function save() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(load())));
  } catch {
    // Nothing to do about a full or unavailable store; the memory copy stands.
  }
}

/** A cached point for this query, if one is already known. Never hits the network. */
export function cachedGeocode(query: string): Coords | null {
  const hit = load().get(query.trim().toLowerCase());
  return hit ? { lng: hit.lng, lat: hit.lat } : null;
}

function validCoords(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}

/**
 * Forward-geocode place text to a point, biased to Australia. Returns null on a
 * miss, a bad answer, or any error — every caller has a fallback for "we don't
 * know where this is", and none of them should fail loudly over it.
 *
 * `types` narrows what counts as an answer. The live map passes place-level
 * types for a station suburb, so "QUEANBEYAN" resolves to the town rather than
 * to a street of that name somewhere else.
 */
export async function forwardGeocode(
  query: string,
  token: string,
  { signal, types }: { signal?: AbortSignal; types?: string } = {},
): Promise<Coords | null> {
  const key = query.trim().toLowerCase();
  if (!key || !token) return null;

  const hit = cachedGeocode(key);
  if (hit) return hit;
  if (missed.has(key)) return null;

  const held = inFlight.get(key);
  if (held) return held;

  const request = (async () => {
    try {
      const url =
        `https://api.mapbox.com/search/geocode/v6/forward` +
        `?q=${encodeURIComponent(query)}&country=au&limit=1` +
        (types ? `&types=${encodeURIComponent(types)}` : "") +
        `&access_token=${token}`;
      const res = await fetch(url, { signal });
      if (!res.ok) return null;
      const data = await res.json();
      const point = data?.features?.[0]?.geometry?.coordinates;
      if (!validCoords(point)) {
        missed.add(key);
        return null;
      }
      load().set(key, { lng: point[0], lat: point[1], at: Date.now() });
      save();
      return { lng: point[0], lat: point[1] };
    } catch {
      // Includes the abort a closing modal fires — not a miss, so it isn't
      // recorded as one.
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}
