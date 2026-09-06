/**
 * Load a dump from scripts/migrate-dump.ts into a *different* Supabase project.
 *
 *   TARGET_SUPABASE_URL=https://<new-ref>.supabase.co \
 *   TARGET_SUPABASE_SERVICE_ROLE_KEY=<new service role key> \
 *   npm run migrate:restore -- <dump-dir>
 *
 * Run supabase/schema.sql against the new project FIRST — this only carries
 * rows, not structure. The schema file is idempotent, so it builds a fresh
 * project as-is (tables, indexes, RLS policies, the Realtime publication and
 * the record_pager_messages() function).
 *
 * The target is taken from TARGET_* environment variables rather than
 * .env.local, and the script refuses to write back into the project the dump
 * came from. Both of those exist so a half-finished cutover — where .env.local
 * has been swapped but the dump is stale — can't quietly overwrite live data
 * with an older copy of itself.
 *
 * Rows are upserted, so a run that fails partway can simply be repeated.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { TABLES } from "./migrate-tables";

// Small enough that one bad row's error message stays readable, large enough
// that 54k rows is a couple of hundred requests rather than tens of thousands.
const BATCH = 500;

interface Manifest {
  source: string;
  takenAt: string;
  counts: Record<string, number>;
}

async function upsertBatch(
  url: string,
  key: string,
  table: string,
  rows: unknown[],
  onConflict: string,
) {
  const res = await fetch(
    `${url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // merge-duplicates makes this an upsert; return=minimal keeps the
        // response empty, which matters at this row count.
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
}

async function countRows(url: string, key: string, table: string): Promise<number> {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  const range = res.headers.get("content-range") ?? "";
  const total = range.split("/")[1];
  return Number(total);
}

async function main() {
  const dumpDir = process.argv[2];
  if (!dumpDir) {
    console.error("usage: npm run migrate:restore -- <dump-dir>");
    process.exit(1);
  }
  const url = (process.env.TARGET_SUPABASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.TARGET_SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Set TARGET_SUPABASE_URL and TARGET_SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const manifestPath = join(dumpDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`no manifest.json in ${dumpDir} — is that a dump directory?`);
    process.exit(1);
  }
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  if (manifest.source.replace(/\/$/, "") === url) {
    console.error(
      `refusing to restore into the project this dump came from (${url}).\n` +
        "TARGET_SUPABASE_URL must be the NEW project.",
    );
    process.exit(1);
  }

  console.log(`restoring dump of ${manifest.source}`);
  console.log(`  taken   ${manifest.takenAt}`);
  console.log(`  into    ${url}\n`);

  for (const { name, conflict } of TABLES) {
    const rows: unknown[] = JSON.parse(readFileSync(join(dumpDir, `${name}.json`), "utf-8"));
    if (!rows.length) {
      console.log(`  ${name.padEnd(24)} nothing to restore`);
      continue;
    }
    for (let i = 0; i < rows.length; i += BATCH) {
      await upsertBatch(url, key, name, rows.slice(i, i + BATCH), conflict);
      process.stdout.write(
        `\r  ${name.padEnd(24)} ${Math.min(i + BATCH, rows.length)}/${rows.length}`,
      );
    }
    process.stdout.write("\n");
  }

  console.log("\nverifying row counts against the manifest:");
  let bad = 0;
  for (const { name } of TABLES) {
    const expected = manifest.counts[name] ?? 0;
    const actual = await countRows(url, key, name);
    const ok = actual >= expected; // >= because the feeder may already be writing
    if (!ok) bad++;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${name.padEnd(24)} expected ${String(expected).padStart(7)}  found ${String(actual).padStart(7)}`,
    );
  }
  if (bad) {
    console.error(`\n${bad} table(s) short — do NOT cut over. Re-run; upserts are idempotent.`);
    process.exit(1);
  }
  console.log("\nall tables restored. Safe to swap the environment variables.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
