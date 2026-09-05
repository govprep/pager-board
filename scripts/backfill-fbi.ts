/**
 * Compute the Fire Behaviour Index for incidents already on the board, rather
 * than waiting for their next re-page. One-off/maintenance use — new pages get
 * this at ingest time (see lib/fbi.ts), so this only matters for history.
 *
 *   npm run backfill-fbi                 — most recent 10 incidents
 *   npm run backfill-fbi -- 50           — most recent 50
 *   npm run backfill-fbi -- 20 2000      — most recent 20, 2s between each write
 *
 * Paced rather than fired off in one burst — a bunch of updates landing at
 * once is still 20 individual writes to a live table with Realtime on it.
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { attachFireWeather } from "../lib/fbi";
import type { IncidentRow } from "../lib/incident-merge";

function loadEnvLocal() {
  const envPath = join(import.meta.dirname ?? __dirname, "..", ".env.local");
  try {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env.local — rely on the ambient environment */
  }
}
loadEnvLocal();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const n = Number(process.argv[2]) || 10;
  const delayMs = Number(process.argv[3]) || 2000;

  const { data, error } = await db
    .from("incidents")
    .select("id, incident_no, type, location, coords")
    .order("received_at", { ascending: false })
    .limit(n);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    console.log("No incidents.");
    return;
  }

  const rows: IncidentRow[] = data.map((r) => ({
    id: r.id,
    incident_no: r.incident_no,
    type: r.type,
    location: r.location ?? "",
    coords: r.coords,
  }));

  // Explicit one-off recompute — bypass the 5-minute throttle live ingestion
  // applies (see lib/fbi.ts) so this always reflects the current weather.
  const withFireWeather = await attachFireWeather(db, rows, { force: true });

  for (const [i, row] of withFireWeather.entries()) {
    if (i > 0) await sleep(delayMs);
    const r = row as IncidentRow & Record<string, unknown>;
    const { error: updErr } = await db
      .from("incidents")
      .update({
        primary_fbi: r.primary_fbi,
        secondary_fbi: r.secondary_fbi,
        fbi_station: r.fbi_station,
        fbi_distance_km: r.fbi_distance_km,
        fbi_observed_at: r.fbi_observed_at,
        fbi_computed_at: r.fbi_computed_at,
      })
      .eq("id", r.id);
    if (updErr) {
      console.error(r.id, "->", updErr.message);
      continue;
    }
    console.log(
      r.id,
      "|",
      r.type,
      "->",
      r.primary_fbi != null ? `${r.primary_fbi}/${r.secondary_fbi} (${r.fbi_station}, ${r.fbi_distance_km}km)` : "—",
    );
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
