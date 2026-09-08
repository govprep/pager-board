/**
 * Daily NSW Fire Danger Ratings push.
 *
 * Fetches BOM's registered-user Fire Danger Ratings page (product IDN10026),
 * has Gemini boil it down to three lines in the board's voice, and pushes that
 * to every enrolled device — a once-a-day statewide heads-up, not an incident
 * alert. See lib/fire-ratings.ts for the fetch/parse/summarise pieces and
 * feeder/push.ts:broadcast for the send.
 *
 *   npm run fire-ratings
 *
 * Idempotent on BOM's "Issued at …" line (stored in fire_ratings_state): the
 * first run to see the afternoon update pushes it, later runs that see the same
 * issue do nothing. So it's meant to run twice from cron — once just after BOM
 * issues the PM ratings, and once ten minutes later in case the first was early:
 *
 *   20,30 16 * * *  cd /path/to/pager-board && npm run fire-ratings >> /var/log/fire-ratings.log 2>&1
 *
 * (16:20 and 16:30 in the box's local time — set TZ=Australia/Sydney in the
 * crontab if the box runs on UTC.)
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, BOM_USER/BOM_PASS,
 * GEMINI_API_KEY (and optional GEMINI_MODEL) and the VAPID_* push keys from
 * .env.local. Missing GEMINI_API_KEY or VAPID keys make it a logged no-op
 * rather than an error.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServerClient } from "../lib/supabase-server";
import {
  fetchFireRatings,
  toPrompt,
  summarise,
  isFreshIssue,
  isRecentIssue,
} from "../lib/fire-ratings";
import { broadcast } from "../feeder/push";

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

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[fire-ratings] GEMINI_API_KEY not set — nothing to summarise, skipping");
    return;
  }
  const db = createServerClient(url, key);

  // BOM's Fire Danger Ratings, freshly fetched.
  const ratings = await fetchFireRatings();

  // Have we already pushed this exact issue? Both daily runs read this, and
  // whichever sees the new afternoon issue first is the one that pushes.
  const { data: state, error: stateErr } = await db
    .from("fire_ratings_state")
    .select("issued")
    .eq("id", true)
    .maybeSingle();
  if (stateErr) throw new Error(`fire_ratings_state read: ${stateErr.message}`);

  if (!isFreshIssue(ratings.issued, state?.issued ?? null)) {
    console.log(`[fire-ratings] no new issue (${ratings.issued || "unparsed"}) — nothing to push`);
    return;
  }

  // Never send ratings we can't confirm are recent — a cron misfire or a cached
  // BOM page shouldn't put stale danger ratings on phones. Left unrecorded, so
  // when BOM does publish a fresh issue the next run picks it up.
  if (!isRecentIssue(ratings.issued, Date.now())) {
    console.log(`[fire-ratings] issue is stale (${ratings.issued || "unparsed"}) — not sending`);
    return;
  }

  const model = process.env.GEMINI_MODEL || undefined;
  const summary = await summarise(toPrompt(ratings), { apiKey, model });
  const lines = summary.split("\n");

  // The first line is the lede (the phone's bold title); the rest is the body.
  const note = {
    title: `🔥 ${lines[0]}`,
    body: lines.slice(1).join("\n"),
    tag: "fire-ratings",
  };
  const reached = await broadcast(db, note);

  // Record the issue only once we've fetched, summarised and broadcast it. A
  // fetch or summary failure throws above and never reaches here, so the next
  // run retries the same issue rather than skipping it as already done.
  const { error: upErr } = await db
    .from("fire_ratings_state")
    .upsert({ id: true, issued: ratings.issued, pushed_at: new Date().toISOString() });
  if (upErr) throw new Error(`fire_ratings_state write: ${upErr.message}`);

  console.log(
    `[fire-ratings] pushed "${ratings.issued}" to ${reached} device(s):\n` +
      `${note.title}\n${note.body}`,
  );
}

main().catch((err) => {
  console.error("[fire-ratings]", (err as Error).message);
  process.exitCode = 1;
});
