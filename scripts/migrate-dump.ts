/**
 * Dump every table out of a Supabase project, via PostgREST.
 *
 *   npm run migrate:dump -- <out-dir>
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local,
 * so it dumps whichever project those currently point at.
 *
 * PostgREST rather than pg_dump because this project has never held a direct
 * Postgres password — the feeder, the API routes and the scripts all talk to
 * the REST endpoint with the service role key. That's enough: the schema lives
 * in supabase/schema.sql (idempotent, so it rebuilds a new project as-is) and
 * this only has to carry the rows.
 *
 * WHAT IT WRITES CONTAINS SECRETS. members.invite_token and
 * member_devices.device_token are the durable credentials every enrolled phone
 * holds, and push_subscriptions carries each device's push endpoint and keys.
 * The output is for local use during a migration and nothing else — don't
 * commit it, don't paste it anywhere.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { TABLES } from "./migrate-tables";

function loadEnvLocal() {
  const envPath = join(import.meta.dirname ?? __dirname, "..", ".env.local");
  try {
    for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // optional
  }
}
loadEnvLocal();


const PAGE = 1000;

/**
 * Page a table with a keyset cursor, not limit/offset.
 *
 * The feeder writes continuously, and under limit/offset an insert that lands
 * before the current window shifts every later row back by one — so the next
 * page starts one row late and that row is never dumped. A cursor on the sort
 * column can't shift underneath itself.
 *
 * The cursor is `gte`, not `gt`, so a page boundary that falls in the middle of
 * a run of equal sort values doesn't step over the rest of the run; the overlap
 * that creates is removed by deduplicating on the primary key. That's what lets
 * a table with a composite key (incident_subscriptions) be paged by one of its
 * columns safely.
 */
async function dumpTable(
  url: string,
  key: string,
  table: string,
  orderBy: string,
  conflict: string,
) {
  const keyCols = conflict.split(",");
  const idOf = (row: Record<string, unknown>) => JSON.stringify(keyCols.map((c) => row[c]));

  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;

  for (;;) {
    const params = new URLSearchParams({
      select: "*",
      order: `${orderBy}.asc`,
      limit: String(PAGE),
    });
    if (cursor !== null) params.set(orderBy, `gte.${cursor}`);

    const res = await fetch(`${url}/rest/v1/${table}?${params}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const page = (await res.json()) as Record<string, unknown>[];
    if (!page.length) break;

    let added = 0;
    for (const row of page) {
      const id = idOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
      added++;
    }

    if (page.length < PAGE) break;
    // Every row on this page was one we already had: the whole page is a single
    // repeated sort value, so the cursor can never advance past it.
    if (added === 0) {
      throw new Error(
        `${table}: more than ${PAGE} rows share ${orderBy}=${cursor} — page by a different column`,
      );
    }
    cursor = String(page[page.length - 1][orderBy]);
  }
  return rows;
}

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: npm run migrate:dump -- <out-dir>");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const manifest: Record<string, number> = {};

  console.log(`dumping ${url}`);
  for (const { name, orderBy, conflict } of TABLES) {
    const rows = await dumpTable(url, key, name, orderBy, conflict);
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(rows, null, 0));
    manifest[name] = rows.length;
    console.log(`  ${name.padEnd(24)} ${String(rows.length).padStart(7)} rows`);
  }

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify({ source: url, takenAt: new Date().toISOString(), counts: manifest }, null, 2),
  );
  console.log(`\nwrote ${Object.values(manifest).reduce((a, b) => a + b, 0)} rows to ${outDir}`);
  console.log("manifest.json holds the per-table counts the restore verifies against.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
