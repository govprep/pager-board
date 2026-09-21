// Current 10-minute AFDRS station observations from BOM's registered-user
// service. This module owns the wire format and credentials; callers only see
// the small, explicit shape that is safe to return to an enrolled browser.

const BOM_URL =
  "https://reg.bom.gov.au/reguser/by_prod/afdrs/api/index.php/fire-weather-observations?product=IDZ20081&region=nsw";

const BOM_TIMEOUT_MS = 8_000;

export type FuelSlot = "primary" | "secondary";

export interface StationFuelObservation {
  slot: FuelSlot;
  model: string | null;
  name: string | null;
  code: number | null;
  fbi: number | null;
  fdr: number | null;
}

export interface CurrentFireWeatherStation {
  id: string;
  name: string;
  description: string | null;
  lat: number;
  lng: number;
  observedAt: string;
  tempC: number | null;
  humidityPct: number | null;
  windDir: string | null;
  windSpdKmh: number | null;
  windGustKmh: number | null;
  primary: StationFuelObservation;
  secondary: StationFuelObservation;
  /** Highest available FBI across primary and secondary only. */
  maxFbi: number | null;
  /** The AFDRS band containing maxFbi: 0 No Rating through 4 Catastrophic. */
  maxFdr: number | null;
  maxFuel: FuelSlot | null;
  olderThan30Min: boolean;
  incomplete: boolean;
}

export interface FireWeatherObservationSnapshot {
  stations: CurrentFireWeatherStation[];
  /** All records in the feed, including portable/unlocated stations. */
  sourceStationCount: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** AFDRS FBI thresholds published by BOM: 0–11, 12–23, 24–49, 50–99, 100+. */
export function fdrForFbi(fbi: number | null): number | null {
  if (fbi == null || fbi < 0) return null;
  if (fbi >= 100) return 4;
  if (fbi >= 50) return 3;
  if (fbi >= 24) return 2;
  if (fbi >= 12) return 1;
  return 0;
}

function fuel(
  slot: FuelSlot,
  info: Record<string, unknown>,
  obs: Record<string, unknown>,
): StationFuelObservation {
  const prefix = slot === "primary" ? "primary" : "secondary";
  return {
    slot,
    model: text(info[`${prefix}_fbm`]),
    name: text(info[`${prefix}_fine_fuel_name`]),
    code: number(info[`${prefix}_fine_fuel_type_code`]),
    fbi: number(obs[`${prefix}_fbi`]),
    fdr: number(obs[`${prefix}_fdr`]),
  };
}

/**
 * Parse every located station, including stations whose FBI is unavailable.
 * The latter are important on the map: a gap should look like a gap, not like
 * an observation of low fire danger.
 *
 * BOM also supplies a third "fuel at point" calculation. It is deliberately
 * excluded: the product and the existing board describe primary/secondary as
 * fuel types 1/2, and the map's stated maximum is over those same two inputs.
 */
export function parseFireWeatherObservations(body: unknown): CurrentFireWeatherStation[] {
  const root = record(body);
  const rows = Array.isArray(root?.data) ? root.data : [];
  const stations: CurrentFireWeatherStation[] = [];

  for (const raw of rows) {
    const row = record(raw);
    const info = record(row?.station_info);
    const obs = record(row?.observation_data);
    if (!info || !obs) continue;

    const lat = number(info.latitude);
    const lng = number(info.longitude);
    const epoch = number(obs.seconds_since_epoch);
    if (lat == null || lng == null || epoch == null) continue;

    const primary = fuel("primary", info, obs);
    const secondary = fuel("secondary", info, obs);
    const available = [primary, secondary].filter(
      (item): item is StationFuelObservation & { fbi: number } => item.fbi != null,
    );
    const highest = available.reduce<typeof available[number] | null>(
      (held, item) => held == null || item.fbi > held.fbi ? item : held,
      null,
    );
    const name = text(info.station_name) ?? text(info.description) ?? "Unnamed station";
    const rawId = number(info.bom_id) ?? number(info.wmo_id);

    stations.push({
      id: rawId != null ? String(rawId) : `${name}:${lat}:${lng}`,
      name,
      description: text(info.description),
      lat,
      lng,
      observedAt: new Date(epoch * 1000).toISOString(),
      tempC: number(obs.temp),
      humidityPct: number(obs.rh),
      windDir: text(obs.wind_dir),
      windSpdKmh: number(obs.wnd_spd_kmh),
      windGustKmh: number(obs.wnd_gust_spd_kmh),
      primary,
      secondary,
      maxFbi: highest?.fbi ?? null,
      // Derive the display band from the maximum FBI so the numeric and band
      // views can never select different fuels or disagree at a threshold.
      maxFdr: fdrForFbi(highest?.fbi ?? null),
      maxFuel: highest?.slot ?? null,
      olderThan30Min: info.obs_older_than_30min === true,
      incomplete: info.incomplete_obs === true,
    });
  }

  return stations;
}

export function parseFireWeatherObservationSnapshot(body: unknown): FireWeatherObservationSnapshot {
  const root = record(body);
  return {
    stations: parseFireWeatherObservations(body),
    sourceStationCount: Array.isArray(root?.data) ? root.data.length : 0,
  };
}

/** Fetch one uncached snapshot. Caching policy belongs to each server caller. */
export async function fetchFireWeatherObservationSnapshot(
  fetchImpl: typeof fetch = fetch,
): Promise<FireWeatherObservationSnapshot> {
  const user = process.env.BOM_USER;
  const pass = process.env.BOM_PASS;
  if (!user || !pass) throw new Error("BOM_USER/BOM_PASS not set");

  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetchImpl(BOM_URL, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(BOM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`BOM fire weather fetch failed: ${res.status}`);

  const snapshot = parseFireWeatherObservationSnapshot(await res.json());
  if (snapshot.stations.length === 0) throw new Error("BOM returned no located fire weather stations");
  return snapshot;
}

/** Compatibility helper for incident enrichment, which only needs the rows. */
export async function fetchFireWeatherObservations(
  fetchImpl: typeof fetch = fetch,
): Promise<CurrentFireWeatherStation[]> {
  return (await fetchFireWeatherObservationSnapshot(fetchImpl)).stations;
}
