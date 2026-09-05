import type { SupabaseClient } from "@supabase/supabase-js";
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

// A job re-paged to another brigade a minute later reuses the figure already
// on the board rather than recomputing one — the weather hasn't moved, and a
// number that changes on every re-page reads as noisier than it is. Keyed per
// incident_no (see attachFireWeather), not wall-clock since the last BOM
// fetch, so a quiet job's first page after a lull still gets a fresh number.
const THROTTLE_MS = 5 * 60_000;

interface Station {
  name: string;
  lat: number;
  lng: number;
  primaryFbi: number;
  secondaryFbi: number;
  /** When this station's reading was taken (unix seconds). */
  observedAtEpoch: number;
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
    if (typeof obs?.seconds_since_epoch !== "number") continue;
    stations.push({
      name: info.station_name ?? info.description ?? "",
      lat: info.latitude,
      lng: info.longitude,
      primaryFbi: obs.primary_fbi,
      secondaryFbi: obs.secondary_fbi ?? obs.primary_fbi,
      observedAtEpoch: obs.seconds_since_epoch,
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

/** The stored snapshot attachFireWeather reads back to decide whether a job's
 *  figure is fresh enough to reuse. */
interface StoredFireWeather {
  primary_fbi: number;
  secondary_fbi: number;
  fbi_station: string;
  fbi_distance_km: number;
  fbi_observed_at: string;
  fbi_computed_at: string;
}

/**
 * Stamp every row with the nearest station's primary/secondary FBI, or null on
 * all fields when the row doesn't qualify (wrong type, no coords, or the BOM
 * feed isn't reachable). Always sets every field so a batch's rows keep
 * uniform keys for the upsert — see feeder/poster.ts and lib/store.ts.
 *
 * Rows are grouped by incident_no, not by row id: several rows can be
 * different brigades paged to the same job, and they must all show the same
 * figure. One BOM lookup covers the whole group, and a group whose incident_no
 * already has a figure computed within THROTTLE_MS reuses it unchanged rather
 * than recomputing — pass `force: true` (scripts/backfill-fbi.ts) to skip that
 * check for a deliberate one-off recompute.
 */
export async function attachFireWeather<T extends IncidentRow>(
  db: SupabaseClient,
  rows: T[],
  opts: { force?: boolean } = {},
): Promise<T[]> {
  for (const row of rows) {
    const r = row as IncidentRow & Record<string, unknown>;
    r.primary_fbi = null;
    r.secondary_fbi = null;
    r.fbi_station = null;
    r.fbi_distance_km = null;
    r.fbi_observed_at = null;
    r.fbi_computed_at = null;
  }

  const byIncident = new Map<string, T[]>();
  for (const row of rows) {
    const r = row as IncidentRow & Record<string, unknown>;
    if (r.coords == null || !isFireWeatherType(String(r.type ?? ""))) continue;
    const incNo = String(r.incident_no || r.id);
    if (!byIncident.has(incNo)) byIncident.set(incNo, []);
    byIncident.get(incNo)!.push(row);
  }
  if (byIncident.size === 0) return rows;

  const stations = await getStations();
  if (stations.length === 0) return rows;

  // What's already on the board for these incident numbers, so a re-page
  // within the throttle window can reuse it instead of recomputing.
  const stored = new Map<string, StoredFireWeather>();
  if (!opts.force) {
    const incidentNos = [...byIncident.keys()];
    for (let i = 0; i < incidentNos.length; i += 200) {
      const { data, error } = await db
        .from("incidents")
        .select("incident_no, primary_fbi, secondary_fbi, fbi_station, fbi_distance_km, fbi_observed_at, fbi_computed_at")
        .in("incident_no", incidentNos.slice(i, i + 200))
        .not("fbi_computed_at", "is", null);
      if (error) {
        console.error("[fbi] stored lookup:", error.message);
        continue;
      }
      for (const row of (data ?? []) as (StoredFireWeather & { incident_no: string })[]) {
        const held = stored.get(row.incident_no);
        if (!held || row.fbi_computed_at > held.fbi_computed_at) stored.set(row.incident_no, row);
      }
    }
  }

  const now = Date.now();
  for (const [incNo, group] of byIncident) {
    const prior = stored.get(incNo);
    if (prior && now - new Date(prior.fbi_computed_at).getTime() < THROTTLE_MS) {
      for (const row of group) {
        const r = row as IncidentRow & Record<string, unknown>;
        r.primary_fbi = prior.primary_fbi;
        r.secondary_fbi = prior.secondary_fbi;
        r.fbi_station = prior.fbi_station;
        r.fbi_distance_km = prior.fbi_distance_km;
        r.fbi_observed_at = prior.fbi_observed_at;
        r.fbi_computed_at = prior.fbi_computed_at;
      }
      continue;
    }

    // Every row in the group is the same job, so the same coordinates.
    const c = (group[0] as IncidentRow).coords as { lat: number; lng: number };
    let best: Station | null = null;
    let bestKm = Infinity;
    for (const s of stations) {
      const km = haversineKm(c, s);
      if (km < bestKm) {
        bestKm = km;
        best = s;
      }
    }
    if (!best) continue;

    const computedAt = new Date().toISOString();
    const observedAt = new Date(best.observedAtEpoch * 1000).toISOString();
    const distanceKm = Math.round(bestKm * 10) / 10;
    for (const row of group) {
      const r = row as IncidentRow & Record<string, unknown>;
      r.primary_fbi = best.primaryFbi;
      r.secondary_fbi = best.secondaryFbi;
      r.fbi_station = best.name;
      r.fbi_distance_km = distanceKm;
      r.fbi_observed_at = observedAt;
      r.fbi_computed_at = computedAt;
    }
  }

  return rows;
}
