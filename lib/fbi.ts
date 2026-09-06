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

// How long to wait on BOM before giving up and serving the cached figure. This
// call is on the ingest path (see fetchStations), so the ceiling matters more
// than the answer — a page reaching the board late is worse than one reaching it
// with a five-minute-old fire index.
const BOM_TIMEOUT_MS = 8_000;

/** The raw observation values the modal's Weather tab shows. */
export interface FireObservation {
  tempC: number | null;
  humidityPct: number | null;
  windDir: string | null;
  windSpdKmh: number | null;
  windGustKmh: number | null;
  /**
   * What the two ratings are ratings *of*.
   *
   * Primary and secondary are not two places — they're two fuels at the same
   * station, and which two depends entirely on where the station is: Cessnock
   * reads Forest against Shrubland, Wilcannia reads Grassland against Spinifex.
   * Without these the modal shows "23 / 7" and leaves the reader to guess which
   * half applies to the country the job is actually in.
   *
   * `Model` is BOM's fire behaviour model ("Forest", "Grassland") and `Name` the
   * vegetation it stands for ("Swamp forests"). They come off `station_info`
   * rather than the observation, but ride in this blob because `fbi_observation`
   * is jsonb and the schema is applied by hand — see supabase/schema.sql. Older
   * rows simply have no such keys, and read as null.
   */
  primaryFuelModel: string | null;
  primaryFuelName: string | null;
  secondaryFuelModel: string | null;
  secondaryFuelName: string | null;
}

interface Station {
  name: string;
  lat: number;
  lng: number;
  primaryFbi: number;
  secondaryFbi: number;
  /** When this station's reading was taken (unix seconds). */
  observedAtEpoch: number;
  observation: FireObservation;
}

let cache: { at: number; stations: Station[] } | null = null;

// When BOM was last asked, successful or not. The failure paths deliberately
// leave `cache` alone (see getStations), so this is what stops a broken feed
// from being re-fetched on every single batch.
let lastAttempt = 0;

// Said once per process rather than per lookup.
let warnedUnconfigured = false;

function bomConfigured(): boolean {
  return !!process.env.BOM_USER && !!process.env.BOM_PASS;
}

/** A BOM string field, or null when it's absent, blank or not a string. */
function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

async function fetchStations(): Promise<Station[]> {
  const user = process.env.BOM_USER;
  const pass = process.env.BOM_PASS;
  if (!user || !pass) return [];

  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  // Bounded, because this sits on the ingest path: once every CACHE_MS a batch
  // pays for this call before its rows can be upserted, and a socket that hangs
  // rather than refusing would stall that batch indefinitely with nothing to cut
  // it off. On timeout getStations() falls back to the last good cache exactly
  // as it does for any other failure, so a slow BOM costs one stale figure, not
  // a stuck feeder.
  const res = await fetch(BOM_URL, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(BOM_TIMEOUT_MS),
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
      observation: {
        tempC: typeof obs.temp === "number" ? obs.temp : null,
        humidityPct: typeof obs.rh === "number" ? obs.rh : null,
        windDir: typeof obs.wind_dir === "string" ? obs.wind_dir : null,
        windSpdKmh: typeof obs.wnd_spd_kmh === "number" ? obs.wnd_spd_kmh : null,
        windGustKmh: typeof obs.wnd_gust_spd_kmh === "number" ? obs.wnd_gust_spd_kmh : null,
        // Which fuel each rating describes — off station_info, not the reading.
        primaryFuelModel: text(info.primary_fbm),
        primaryFuelName: text(info.primary_fine_fuel_name),
        secondaryFuelModel: text(info.secondary_fbm),
        secondaryFuelName: text(info.secondary_fine_fuel_name),
      },
    });
  }
  return stations;
}

// Best-effort: a fetch failure serves the last good cache (if any) rather than
// blocking ingestion, and an empty result leaves rows on whatever figure they
// already had (see attachFireWeather's fallback).
//
// Nothing here is allowed to fail *silently*. Missing credentials used to
// return an empty list from fetchStations without a word — no throw, no log —
// and the empty result was then stored as though it were a good fetch. The
// whole feature became a no-op that looked exactly like "no fires today": every
// qualifying job got a null FBI and the log said nothing at all. So the two
// empty cases each say so, and neither is written to `cache`, which keeps the
// last good list serving and lets the very next cycle recover.
async function getStations(): Promise<Station[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.stations;

  if (!bomConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        "[fbi] BOM_USER/BOM_PASS not set — no incident will get an FBI. " +
          "Add them to .env.local (see .env.example) and restart the feeder.",
      );
    }
    return [];
  }

  // Rate-limit the *attempt*, not just the success, so a feed that is erroring
  // or answering in a shape we don't recognise isn't hit on every batch.
  if (Date.now() - lastAttempt < CACHE_MS) return cache?.stations ?? [];
  lastAttempt = Date.now();

  try {
    const stations = await fetchStations();
    if (stations.length) {
      cache = { at: Date.now(), stations };
      return stations;
    }
    console.warn(
      "[fbi] BOM returned no usable stations — credentials may be rejected, " +
        "or the feed's fields have changed shape (see fetchStations)",
    );
    return cache?.stations ?? [];
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
  fbi_observation: FireObservation;
}

function applyStored(group: IncidentRow[], prior: StoredFireWeather) {
  for (const row of group) {
    const r = row as IncidentRow & Record<string, unknown>;
    r.primary_fbi = prior.primary_fbi;
    r.secondary_fbi = prior.secondary_fbi;
    r.fbi_station = prior.fbi_station;
    r.fbi_distance_km = prior.fbi_distance_km;
    r.fbi_observed_at = prior.fbi_observed_at;
    r.fbi_computed_at = prior.fbi_computed_at;
    r.fbi_observation = prior.fbi_observation;
  }
}

function applyNull(group: IncidentRow[]) {
  for (const row of group) {
    const r = row as IncidentRow & Record<string, unknown>;
    r.primary_fbi = null;
    r.secondary_fbi = null;
    r.fbi_station = null;
    r.fbi_distance_km = null;
    r.fbi_observed_at = null;
    r.fbi_computed_at = null;
    r.fbi_observation = null;
  }
}

/**
 * Stamp every row with the nearest station's primary/secondary FBI, or null on
 * all fields when the row doesn't qualify at all (wrong type, or no coords —
 * this is what excludes FRNSW pages outright). Always sets every field so a
 * batch's rows keep uniform keys for the upsert — see feeder/poster.ts and
 * lib/store.ts.
 *
 * Rows are grouped by incident_no, not by row id: several rows can be
 * different brigades paged to the same job, and they must all show the same
 * figure. A group whose incident_no already has a figure computed within
 * THROTTLE_MS reuses it unchanged rather than recomputing — pass
 * `force: true` (scripts/backfill-fbi.ts) to skip that check for a deliberate
 * one-off recompute.
 *
 * Critically, a qualifying row that can't get a *fresh* figure right now (BOM
 * unreachable, no matching station, a failed stored-lookup) falls back to
 * whatever figure is already stored for its incident_no, however stale,
 * rather than being nulled — a job's FBI must never flicker to blank on a
 * re-page just because one particular ingest hit a transient hiccup. Only a
 * genuinely ineligible row, or one that has truly never had a figure, ends up
 * null.
 */
export async function attachFireWeather<T extends IncidentRow>(
  db: SupabaseClient,
  rows: T[],
  opts: { force?: boolean } = {},
): Promise<T[]> {
  const byIncident = new Map<string, T[]>();
  for (const row of rows) {
    const r = row as IncidentRow & Record<string, unknown>;
    if (r.coords == null || !isFireWeatherType(String(r.type ?? ""))) {
      // Genuinely doesn't qualify — re-typed away from fire, or never had
      // coords. This is the one case that's always null.
      applyNull([row]);
      continue;
    }
    const incNo = String(r.incident_no || r.id);
    if (!byIncident.has(incNo)) byIncident.set(incNo, []);
    byIncident.get(incNo)!.push(row);
  }
  if (byIncident.size === 0) return rows;

  // What's already on the board for these incident numbers — the throttle's
  // reuse source, and now also the fallback for a group whose fresh lookup
  // fails outright, so always fetched regardless of `force`.
  const stored = new Map<string, StoredFireWeather>();
  const incidentNos = [...byIncident.keys()];
  for (let i = 0; i < incidentNos.length; i += 200) {
    const { data, error } = await db
      .from("incidents")
      .select(
        `incident_no, primary_fbi, secondary_fbi, fbi_station, fbi_distance_km,
         fbi_observed_at, fbi_computed_at, fbi_observation`,
      )
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

  const stations = await getStations();
  const now = Date.now();

  for (const [incNo, group] of byIncident) {
    const prior = stored.get(incNo);
    const withinThrottle =
      !opts.force && prior != null && now - new Date(prior.fbi_computed_at).getTime() < THROTTLE_MS;
    if (withinThrottle) {
      applyStored(group, prior!);
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

    if (best) {
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
        r.fbi_observation = best.observation;
      }
    } else if (prior) {
      // BOM unreachable, no stations, or (shouldn't happen) no match found —
      // keep showing the last good figure instead of erasing it.
      applyStored(group, prior);
    } else {
      // Never computed before and can't compute now.
      applyNull(group);
    }
  }

  return rows;
}
