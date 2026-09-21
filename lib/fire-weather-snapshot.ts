import type {
  CurrentFireWeatherStation,
  FireWeatherObservationSnapshot,
} from "./fire-weather-observations";
import type { FireWeatherCoverage } from "./fire-weather-coverage";

const EMPTY_COVERAGE: FireWeatherCoverage = { type: "FeatureCollection", features: [] };

// A private Supabase Storage object is the seam between the credentialled
// feeder host and the Vercel app. BOM credentials never need to leave the
// feeder, and one fetch serves every open map.
export const FIRE_WEATHER_BUCKET = "fire-weather";
export const FIRE_WEATHER_OBJECT = "current.json";

export interface StoredFireWeatherSnapshot extends FireWeatherObservationSnapshot {
  fetchedAt: string;
  coverage: FireWeatherCoverage;
}

export function makeStoredFireWeatherSnapshot(
  stations: CurrentFireWeatherStation[],
  sourceStationCount: number,
  fetchedAt: string = new Date().toISOString(),
  coverage: FireWeatherCoverage = EMPTY_COVERAGE,
): StoredFireWeatherSnapshot {
  return { fetchedAt, stations, sourceStationCount, coverage };
}

export function parseStoredFireWeatherSnapshot(value: unknown): StoredFireWeatherSnapshot | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.fetchedAt !== "string" || Number.isNaN(new Date(row.fetchedAt).getTime())) return null;
  if (!Array.isArray(row.stations) || typeof row.sourceStationCount !== "number") return null;
  const coverage = row.coverage;
  if (coverage == null) {
    return { ...(row as unknown as Omit<StoredFireWeatherSnapshot, "coverage">), coverage: EMPTY_COVERAGE };
  }
  if (typeof coverage !== "object" || Array.isArray(coverage) ||
    (coverage as Record<string, unknown>).type !== "FeatureCollection" ||
    !Array.isArray((coverage as Record<string, unknown>).features)) return null;
  return row as unknown as StoredFireWeatherSnapshot;
}
