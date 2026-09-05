/**
 * Inspect and tidy the phones enrolled for push alerts.
 *
 *   npm run alerts                    — list every subscription and its areas
 *   npm run alerts check <no|id>      — who would an incident have alerted?
 *   npm run alerts forget <tail>      — drop a subscription (match its last chars)
 *
 * The list is the answer to "why did my phone buzz for that?": a device on
 * `everything (never chose)` was enrolled before the area picker existed and has
 * simply never been asked. It keeps getting the lot until someone opens the
 * picker on it — the board now offers that automatically on the next visit — or
 * until you `forget` it here.
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServerClient } from "../lib/supabase-server";
import { alertKeysFor, mergeAlertKeys, wantsIncident, type AlertPrefs } from "../lib/alert-prefs";

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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createServerClient(url, key);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

function prefsOf(row: Row): AlertPrefs {
  return {
    alertAll: row.alert_all ?? true,
    lgas: row.lgas ?? [],
    stations: row.stations ?? [],
  };
}

// "…VwWNXxgiUM" — enough of the endpoint to tell devices apart, and the push
// service it belongs to (apple / google / mozilla).
function shortEndpoint(endpoint: string): string {
  let host = "?";
  try {
    host = new URL(endpoint).host.replace(/^(web\.)?push\./, "").replace(/\..*$/, "");
  } catch {
    /* keep "?" */
  }
  return `${host.padEnd(8)} …${endpoint.slice(-10)}`;
}

function describe(row: Row): string {
  const p = prefsOf(row);
  if (p.alertAll) return row.prefs_set_at ? "everything (chosen)" : "everything (never chose)";
  const bits: string[] = [];
  if (p.lgas.length) bits.push(`${p.lgas.length} LGA(s): ${p.lgas.join(", ")}`);
  if (p.stations.length) bits.push(`${p.stations.length} station(s): ${p.stations.join(", ")}`);
  return bits.length ? bits.join(" · ") : "NOTHING — narrowed but no areas picked";
}

async function list() {
  const { data, error } = await db
    .from("push_subscriptions")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  if (!data?.length) return console.log("No devices enrolled for push.");

  const { data: follows } = await db.from("incident_subscriptions").select("endpoint");
  const followCount = new Map<string, number>();
  for (const f of follows ?? []) followCount.set(f.endpoint, (followCount.get(f.endpoint) ?? 0) + 1);

  console.log(`${data.length} device(s) enrolled:\n`);
  for (const row of data) {
    const enrolled = String(row.created_at).slice(0, 10);
    const follows = followCount.get(row.endpoint) ?? 0;
    console.log(`  ${shortEndpoint(row.endpoint)}  enrolled ${enrolled}`);
    console.log(`    gets: ${describe(row)}`);
    console.log(
      `    device id: ${row.device_key ? row.device_key.slice(0, 8) : "— (pre-dates device ids)"}` +
        (follows ? `  ·  following ${follows} incident(s)` : ""),
    );
  }

  const unchosen = data.filter((r) => !r.prefs_set_at).length;
  if (unchosen) {
    console.log(
      `\n${unchosen} device(s) have never picked their areas, so they still get every` +
        `\nincident. The board offers them the picker next time they open it; use` +
        `\n\`npm run alerts forget <tail>\` to cut one loose in the meantime.`,
    );
  }
}

// Replays the feeder's matching for one incident number, so you can see exactly
// which devices it reached and why the others didn't.
async function check(ref: string) {
  const { data: pages, error } = await db
    .from("incidents")
    .select("*")
    .or(`incident_no.eq.${ref},id.eq.${ref}`);
  if (error) throw new Error(error.message);
  if (!pages?.length) return console.log(`No incident matching "${ref}".`);

  const location = pages.find((p) => p.location)?.location ?? "";
  const keys = mergeAlertKeys(pages.map((p) => alertKeysFor(location, p.raw)));

  console.log(`${ref} — ${pages.length} page(s)`);
  console.log(`  location: ${location || "(none — FRNSW pages carry no address)"}`);
  console.log(`  matches on: LGA ${keys.lgaKey || "—"} · stations ${keys.stationKeys.join(", ") || "—"}`);
  if (!keys.lgaKey && !keys.stationKeys.length) {
    console.log("  ⚠ nothing to match on: only devices set to everything can get this.");
  }

  const { data: subs } = await db.from("push_subscriptions").select("*");
  console.log("");
  for (const row of subs ?? []) {
    const hit = wantsIncident(prefsOf(row), keys);
    console.log(`  ${hit ? "ALERTED" : "  —    "} ${shortEndpoint(row.endpoint)}  ${describe(row)}`);
  }
}

async function forget(tail: string) {
  const { data, error } = await db.from("push_subscriptions").select("endpoint, created_at");
  if (error) throw new Error(error.message);
  const matches = (data ?? []).filter((r) => r.endpoint.endsWith(tail));
  if (!matches.length) return console.log(`No subscription ends with "${tail}".`);
  if (matches.length > 1) {
    console.log(`"${tail}" matches ${matches.length} subscriptions — use more characters.`);
    return;
  }
  const { endpoint } = matches[0];
  const { error: delErr } = await db.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (delErr) throw new Error(delErr.message);
  console.log(`Dropped ${shortEndpoint(endpoint)} — that device gets nothing until it re-enables alerts.`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || cmd === "list") return list();
  if (cmd === "check" && arg) return check(arg);
  if (cmd === "forget" && arg) return forget(arg);
  console.log("Usage: npm run alerts [list | check <incident-no> | forget <endpoint-tail>]");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
