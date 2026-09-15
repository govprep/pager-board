/**
 * Re-apply the stand-down rule to history: clear `stopped_at` from resources a
 * stand-down never actually cancelled.
 *
 *   npm run backfill-standdowns            — dry run, prints what would change
 *   npm run backfill-standdowns -- --write  — apply it
 *
 * Until lib/standdown.ts learned to read the brigade off the page's origin, a
 * stop whose text named nobody stood the WHOLE job down — twelve resources off
 * one page that was only ever sent to one of them (job 26-127771). Fixing the
 * rule doesn't touch rows already stamped, so this recomputes them.
 *
 * Only ever CLEARS a stamp. Every stand-down the job ever had is replayed and
 * the rows they cancel are unioned, so a resource stopped by any of them keeps
 * its time; the rest are cleared. Nothing invents a stop that isn't in the feed.
 *
 * A job is only touched if at least one of its stand-downs is still on record.
 * Stand-downs are pulled out before parsing and were never stored in
 * `incidents`, so jobs stopped before /raw shipped have no notice to replay —
 * replaying nothing would "prove" their stops were all wrong and clear the lot.
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServerClient } from "../lib/supabase-server";
import { parseStandDown, unitsNamedBy, unitsPagedFrom } from "../lib/standdown";

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

/** Every row of a table matching one status, paged out in full. */
async function all<T>(
  table: string, columns: string, apply: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(db.from(table).select(columns)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const write = process.argv.includes("--write");

  const notices = await all<{ raw: string; incident_no: string; origin: string | null }>(
    "pager_messages", "raw, incident_no, origin",
    (q) => q.eq("status", "standdown").not("incident_no", "is", null).order("received_at"),
  );
  const turnouts = await all<{ incident_no: string; origin: string | null; raw: string }>(
    "pager_messages", "incident_no, origin, raw",
    (q) => q.eq("status", "incident").not("incident_no", "is", null),
  );
  const rows = await all<{ id: string; incident_no: string; unit: string; stopped_at: string | null }>(
    "incidents", "id, incident_no, unit, stopped_at", (q) => q.not("stopped_at", "is", null),
  );
  // Sibling rows matter even when unstopped: "did this origin single anybody
  // out?" is decided against the whole job, not just its stopped half.
  // Fetched in chunks — the job list goes into the query string.
  const numbers = [...new Set(rows.map((r) => r.incident_no))];
  const siblings: { id: string; incident_no: string; unit: string }[] = [];
  for (let i = 0; i < numbers.length; i += 200) {
    const chunk = numbers.slice(i, i + 200);
    siblings.push(...await all<{ id: string; incident_no: string; unit: string }>(
      "incidents", "id, incident_no, unit", (q) => q.in("incident_no", chunk),
    ));
  }

  const byIncident = new Map<string, typeof siblings>();
  for (const r of siblings) byIncident.set(r.incident_no, [...(byIncident.get(r.incident_no) ?? []), r]);
  const turnoutsBy = new Map<string, typeof turnouts>();
  for (const t of turnouts) turnoutsBy.set(t.incident_no, [...(turnoutsBy.get(t.incident_no) ?? []), t]);

  // Replay every notice; union the rows it genuinely cancels.
  const keep = new Set<string>();
  const replayed = new Set<string>();
  for (const n of notices) {
    const sd = parseStandDown(n.raw, n.origin);
    if (!sd) continue;
    const job = byIncident.get(sd.incidentNo) ?? [];
    if (!job.length) continue;
    replayed.add(sd.incidentNo);

    const named = job.filter((r) => unitsNamedBy(sd, [r.unit ?? ""]).length > 0);
    if (named.length) { for (const r of named) keep.add(r.id); continue; }

    const paged = unitsPagedFrom(sd, job.map((r) => r.unit ?? ""), turnoutsBy.get(sd.incidentNo) ?? []);
    if (paged.length && paged.length < job.length) {
      for (const r of job.filter((r) => paged.includes(r.unit ?? ""))) keep.add(r.id);
    } else {
      for (const r of job) keep.add(r.id);  // nothing singled out — whole job
    }
  }

  const clear = rows.filter((r) => replayed.has(r.incident_no) && !keep.has(r.id));
  const skipped = new Set(
    rows.filter((r) => !replayed.has(r.incident_no)).map((r) => r.incident_no),
  );
  if (skipped.size) {
    console.log(`${skipped.size} job(s) left alone — no stand-down of theirs is on record`);
  }
  const jobs = new Set(clear.map((r) => r.incident_no));
  console.log(`${rows.length} stopped resource(s); clearing ${clear.length} across ${jobs.size} job(s)`);
  for (const job of [...jobs].sort()) {
    const mine = clear.filter((r) => r.incident_no === job);
    const total = (byIncident.get(job) ?? []).length;
    console.log(`  ${job}: clearing ${mine.map((r) => r.unit).join(", ")} (of ${total} on the job)`);
  }
  if (!clear.length) return;

  if (!write) {
    console.log("\nDry run — re-run with --write to apply.");
    return;
  }
  for (let i = 0; i < clear.length; i += 100) {
    const batch = clear.slice(i, i + 100).map((r) => r.id);
    const { error } = await db.from("incidents").update({ stopped_at: null }).in("id", batch);
    if (error) throw new Error(error.message);
    console.log(`cleared ${Math.min(i + 100, clear.length)}/${clear.length}`);
  }
  console.log("done");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
