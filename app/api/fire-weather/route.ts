import { NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/access";
import { supabase } from "@/lib/supabase";
import {
  FIRE_WEATHER_BUCKET,
  FIRE_WEATHER_OBJECT,
  parseStoredFireWeatherSnapshot,
  type StoredFireWeatherSnapshot,
} from "@/lib/fire-weather-snapshot";

export const dynamic = "force-dynamic";

// The feeder owns BOM access and publishes one private snapshot to Supabase
// Storage every 10 minutes. A short server-instance cache avoids downloading it
// repeatedly when several members open the map together.
const CACHE_MS = 60_000;
const STALE_MS = 30 * 60_000;

let cache: { loadedAt: number; snapshot: StoredFireWeatherSnapshot } | null = null;

async function isAuthed(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token !== "" && (await verifyAccessToken(token)) !== null;
}

export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = Date.now();
    let snapshot = cache && now - cache.loadedAt < CACHE_MS ? cache.snapshot : null;
    if (!snapshot) {
      const { data, error } = await supabase.storage
        .from(FIRE_WEATHER_BUCKET)
        .download(FIRE_WEATHER_OBJECT);
      if (error) throw error;
      snapshot = parseStoredFireWeatherSnapshot(JSON.parse(await data.text()));
      if (!snapshot) throw new Error("Stored fire weather snapshot is invalid");
      cache = { loadedAt: now, snapshot };
    }
    const stale = now - new Date(snapshot.fetchedAt).getTime() > STALE_MS;
    return NextResponse.json({ ...snapshot, stale }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[fire-weather] stored observations:", (error as Error).message);
    return NextResponse.json({ error: "Unable to load fire weather observations" }, { status: 503 });
  }
}
