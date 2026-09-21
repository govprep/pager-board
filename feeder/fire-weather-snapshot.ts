import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchFireWeatherObservationSnapshot } from "../lib/fire-weather-observations";
import {
  FIRE_WEATHER_BUCKET,
  FIRE_WEATHER_OBJECT,
  makeStoredFireWeatherSnapshot,
} from "../lib/fire-weather-snapshot";

const REFRESH_MS = 10 * 60_000;

async function ensureBucket(db: SupabaseClient): Promise<void> {
  const { data } = await db.storage.getBucket(FIRE_WEATHER_BUCKET);
  if (data) return;

  const { error } = await db.storage.createBucket(FIRE_WEATHER_BUCKET, {
    public: false,
    allowedMimeTypes: ["application/json"],
    fileSizeLimit: "1MB",
  });
  // Another feeder/startup may have created it between get and create.
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
}

export async function publishFireWeatherSnapshot(db: SupabaseClient): Promise<number> {
  const current = await fetchFireWeatherObservationSnapshot();
  const snapshot = makeStoredFireWeatherSnapshot(
    current.stations,
    current.sourceStationCount,
  );

  await ensureBucket(db);
  const body = Buffer.from(JSON.stringify(snapshot));
  const { error } = await db.storage.from(FIRE_WEATHER_BUCKET).upload(FIRE_WEATHER_OBJECT, body, {
    contentType: "application/json",
    cacheControl: "60",
    upsert: true,
  });
  if (error) throw error;
  return current.stations.length;
}

/** Start immediately, then refresh on the same cadence as BOM's product. */
export function startFireWeatherSnapshots(db: SupabaseClient): void {
  let running = false;
  const publish = async () => {
    if (running) return;
    running = true;
    try {
      const count = await publishFireWeatherSnapshot(db);
      console.log(`[fire-weather] published ${count} located station(s)`);
    } catch (error) {
      console.error("[fire-weather] snapshot:", (error as Error).message);
    } finally {
      running = false;
    }
  };
  void publish();
  setInterval(() => void publish(), REFRESH_MS);
}
