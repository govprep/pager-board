import type { IncidentRow } from "./incident-merge";

// Fire Behaviour Index lookup — attaches the nearest BOM AWS station's current
// primary/secondary FBI to RFS vegetation-fire-type incidents.
//
// Only makes sense for calls where fire weather actually applies (bush, grass,
// scrub, smoke reports, unknown fires) and where we know where the job is.
// FRNSW pages carry no coordinates at all (see lib/parser.ts), so they fall
// out of this for free — the coords check alone is what excludes them.

const BOM_URL =
  "https://reg.bom.gov.au/reguser/by_prod/afdrs/api/index.php/fire-weather-observations?product=IDZ20081&region=nsw";

// BOM refreshes this feed roughly every 10 minutes ("current 10 minute data"),
// so there's no point asking more often than that.
const CACHE_MS = 5 * 60_000;

interface Station {
  name: string;
  lat: number;
  lng: number;
  primaryFbi: number;
  secondaryFbi: number;
}

let cache: { at: number; stations: Station[] } | null = null;

async function fetchStations(): Promise<Station[]> {
  const user = process.env.BOM_USER;
  const pass = process.env.BOM_PASS;
  if (!user || !pass) return [];

  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetch(BOM_URL, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`BOM fire weather fetch failed: ${res.status}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = await res.json();
  const stations: Station[] = [];
  for (const row of body?.data ?? []) {
    const info = row?.station_info;
    const obs = row?.observation_data;
    if (typeof info?.latitude !== "number" || typeof info?.longitude !== "number") continue;
    if (typeof obs?.primary_fbi !== "number") continue;
    stations.push({
      name: info.station_name ?? info.description ?? "",
      lat: info.latitude,
      lng: info.longitude,
      primaryFbi: obs.primary_fbi,
      secondaryFbi: obs.secondary_fbi ?? obs.primary_fbi,
    });
  }
  return stations;
}

// Best-effort: a fetch failure serves the last good cache (if any) rather than
// blocking ingestion, and an empty result quietly leaves rows without an FBI.
async function getStations(): Promise<Station[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.stations;
  try {
    const stations = await fetchStations();
    cache = { at: Date.now(), stations };
    return stations;
  } catch (err) {
    console.error("[fbi]", (err as Error).message);
    return cache?.stations ?? [];
  }
}

const EARTH_RADIUS_KM = 6371;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// Calls fire weather doesn't apply to, even when the type also mentions smoke
// or a vegetation word in passing (e.g. control notes) — checked first so it
// wins over the include list below.
const EXCLUDE_TYPE_RE =
  /\bALARM\b|\bSTRUCTURE\b|\bBUILDING\b|\bHOUSE\b|\bVEHICLE\b|\bCAR\b|\bTRUCK\b|\bCHIMNEY\b/i;

// The RFS nature-of-call words fire weather is meaningful for.
const INCLUDE_TYPE_RE = /\bBUSH\b|\bGRASS\b|\bSCRUB\b|\bVEGETATION\b|\bSMOKE\b|\bUNKNOWN\s*FIRE\b/i;

export function isFireWeatherType(type: string): boolean {
  const t = (type ?? "").trim();
  if (!t) return false;
  if (EXCLUDE_TYPE_RE.test(t)) return false;
  return INCLUDE_TYPE_RE.test(t);
}

/**
 * Stamp every row with the nearest station's primary/secondary FBI, or null on
 * all four fields when the row doesn't qualify (wrong type, no coords, or the
 * BOM feed isn't reachable). Always sets all four so a batch's rows keep
 * uniform keys for the upsert — see feeder/poster.ts and lib/store.ts.
 */
export async function attachFireWeather<T extends IncidentRow>(rows: T[]): Promise<T[]> {
  const needsStations = rows.some(
    (r) => r.coords != null && isFireWeatherType(String((r as Record<string, unknown>).type ?? "")),
  );
  const stations = needsStations ? await getStations() : [];

  for (const row of rows) {
    const r = row as IncidentRow & Record<string, unknown>;
    r.primary_fbi = null;
    r.secondary_fbi = null;
    r.fbi_station = null;
    r.fbi_distance_km = null;

    if (stations.length === 0) continue;
    if (r.coords == null || !isFireWeatherType(String(r.type ?? ""))) continue;

    const c = r.coords as { lat: number; lng: number };
    let best: Station | null = null;
    let bestKm = Infinity;
    for (const s of stations) {
      const km = haversineKm(c, s);
      if (km < bestKm) {
        bestKm = km;
        best = s;
      }
    }
    if (best) {
      r.primary_fbi = best.primaryFbi;
      r.secondary_fbi = best.secondaryFbi;
      r.fbi_station = best.name;
      r.fbi_distance_km = Math.round(bestKm * 10) / 10;
    }
  }
  return rows;
}
