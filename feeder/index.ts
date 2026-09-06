/**
 * Pager feeder — runs alongside the Next.js dev/prod server.
 * Polls all configured sources and POSTs raw pager lines to the board.
 *
 * Start: npm run feeder
 *
 * Sources enabled based on env vars present in .env.local:
 *   PAGERMON_URL  → your PagerMon REST API
 *   (always)      → rfspager.app HTML scraper
 *   (always)      → the public PagerMon instances in sources/public-pagermon.ts
 *                   (pocsag.net, pager.forcequit.xyz, pager-feed.net) over
 *                   Socket.IO — each silently skips if unreachable
 *   FEEDER_PROXY_<LABEL>
 *                 → routes that one public instance through a SOCKS5 proxy.
 *                   FEEDER_PROXY_FORCEQUIT is what switches pager.forcequit.xyz
 *                   back on: Cloudflare 403s this host's IP, so its socket goes
 *                   out through a residential connection instead.
 *   TG_SESSION    → Telegram group (also needs TG_API_ID, TG_API_HASH, TG_GROUP)
 */

// Load .env.local so this script shares the same config as the Next.js app.
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnvLocal() {
  const envPath = join(import.meta.dirname ?? __dirname, "..", ".env.local");
  try {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env.local is optional
  }
}
loadEnvLocal();

import { makeWriter } from "./poster";
import { pollPagerMon } from "./sources/pagermon";
import { pollRfsPager } from "./sources/rfspager";
import { pollPublicPagerMons } from "./sources/public-pagermon";
import { pollTelegram } from "./sources/telegram";

(async () => {
  const { post } = makeWriter();

  console.log("Pager feeder starting — writing direct to Supabase");

  pollPagerMon(post);
  pollRfsPager(post);
  pollPublicPagerMons(post);
  pollTelegram(post);
})();
