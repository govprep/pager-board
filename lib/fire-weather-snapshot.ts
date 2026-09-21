import type {
  CurrentFireWeatherStation,
  FireWeatherObservationSnapshot,
} from "./fire-weather-observations";

// A private Supabase Storage object is the seam between the credentialled
// feeder host and the Vercel app. BOM credentials never need to leave the
// feeder, and one fetch serves every open map.
export const FIRE_WEATHER_BUCKET = "fire-weather";
export const FIRE_WEATHER_OBJECT = "current.json";

export interface StoredFireWeatherSnapshot extends FireWeatherObservationSnapshot {
  fetchedAt: string;
}

export function makeStoredFireWeatherSnapshot(
  stations: CurrentFireWeatherStation[],
  sourceStationCount: number,
  fetchedAt: string = new Date().toISOString(),
): StoredFireWeatherSnapshot {
  return { fetchedAt, stations, sourceStationCount };
}

export function parseStoredFireWeatherSnapshot(value: unknown): StoredFireWeatherSnapshot | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.fetchedAt !== "string" || Number.isNaN(new Date(row.fetchedAt).getTime())) return null;
  if (!Array.isArray(row.stations) || typeof row.sourceStationCount !== "number") return null;
  return row as unknown as StoredFireWeatherSnapshot;
}
