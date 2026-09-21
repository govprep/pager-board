import { NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/access";
import {
  fetchFireWeatherObservationSnapshot,
  type CurrentFireWeatherStation,
} from "@/lib/fire-weather-observations";

export const dynamic = "force-dynamic";

// The source is a 10-minute product. Keep one snapshot per server instance for
// just under that period so many open maps don't multiply requests to BOM.
const CACHE_MS = 9 * 60_000;
const FAILED_RETRY_MS = 60_000;

let cache: {
  fetchedAt: string;
  stations: CurrentFireWeatherStation[];
  sourceStationCount: number;
} | null = null;
let lastAttempt = 0;

async function isAuthed(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token !== "" && (await verifyAccessToken(token)) !== null;
}

export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  if (cache && now - new Date(cache.fetchedAt).getTime() < CACHE_MS) {
    return NextResponse.json({ ...cache, stale: false }, { headers: { "Cache-Control": "private, no-store" } });
  }
  if (cache && now - lastAttempt < FAILED_RETRY_MS) {
    return NextResponse.json({ ...cache, stale: true }, { headers: { "Cache-Control": "private, no-store" } });
  }

  lastAttempt = now;
  try {
    const snapshot = await fetchFireWeatherObservationSnapshot();
    cache = { fetchedAt: new Date().toISOString(), ...snapshot };
    return NextResponse.json({ ...cache, stale: false }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[fire-weather] current observations:", (error as Error).message);
    if (cache) {
      return NextResponse.json({ ...cache, stale: true }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json({ error: "Unable to load fire weather observations" }, { status: 503 });
  }
}
