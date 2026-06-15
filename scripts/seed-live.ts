/**
 * Hot-flush the board and seed it with the last 5 real incidents from
 * PagerMon (cmssweb) and rfspager.app.
 *
 * Usage: npm run seed:live
 * Requires the board to be running: npm run dev
 */

import { readFileSync } from "node:fs";
import { isValidPagerLine } from "../feeder/filter";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname =
  typeof import.meta !== "undefined" && import.meta.url
    ? dirname(fileURLToPath(import.meta.url))
    : (globalThis as Record<string, unknown>).__dirname as string ?? ".";

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // optional
  }
}
loadEnvLocal();

const BOARD = (process.env.BOARD_URL ?? "http://localhost:3000").replace(/\/$/, "");
const PAGERMON_URL = process.env.PAGERMON_URL?.replace(/\/$/, "");
const PAGERMON_USER = process.env.PAGERMON_USER ?? "";
const PAGERMON_PASS = process.env.PAGERMON_PASS ?? "";
const TG_API_ID = Number(process.env.TG_API_ID ?? "0");
const TG_API_HASH = process.env.TG_API_HASH ?? "";
const TG_SESSION = process.env.TG_SESSION ?? "";
const TG_GROUP = process.env.TG_GROUP ?? "";

// ── helpers ─────────────────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

// ── sources ──────────────────────────────────────────────────────────────────

async function fetchPagerMon(limit: number): Promise<string[]> {
  if (!PAGERMON_URL || !PAGERMON_USER || !PAGERMON_PASS) {
    console.error("  PAGERMON_URL, PAGERMON_USER, PAGERMON_PASS required in .env.local");
    return [];
  }

  // Login to get session cookie.
  const loginRes = await fetch(`${PAGERMON_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: PAGERMON_USER, password: PAGERMON_PASS }),
    redirect: "manual",
  });
  const cookieHeader = loginRes.headers.get("set-cookie");
  if (!cookieHeader) {
    console.error("  PagerMon login failed (no cookie returned)");
    return [];
  }
  const cookie = cookieHeader.split(";")[0].trim();

  const params = new URLSearchParams({ limit: String(limit) });
  const res = await fetch(`${PAGERMON_URL}/api/messages?${params}`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
  if (!res.ok) {
    console.error(`  PagerMon HTTP ${res.status}`);
    return [];
  }
  const data: unknown = await res.json();
  const messages: Record<string, unknown>[] = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : ((data as { messages?: Record<string, unknown>[] }).messages ?? []);
  return messages
    .filter((m) => !m.ignore && isValidPagerLine((m.message as string | undefined) ?? ""))
    .slice(0, limit)
    .map((m) => (m.message as string | undefined)?.trim() ?? "")
    .filter((l) => l.length > 4);
}

async function fetchRfsPager(limit: number): Promise<string[]> {
  const res = await fetch("https://rfspager.app/pager", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    console.error(`  rfspager HTTP ${res.status}`);
    return [];
  }
  const html = await res.text();

  // Prefer structured JSON embedded by Next.js SSR.
  const ndMatch = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]) as {
        props?: { pageProps?: Record<string, unknown[]> };
      };
      const pp = nd.props?.pageProps ?? {};
      const msgs =
        (pp.messages as Record<string, unknown>[] | undefined) ??
        (pp.incidents as Record<string, unknown>[] | undefined) ??
        (pp.pagerMessages as Record<string, unknown>[] | undefined) ??
        [];
      if (msgs.length > 0) {
        const lines = msgs
          .slice(0, limit)
          .map(
            (m) =>
              (m.message as string | undefined)?.trim() ??
              (m.raw as string | undefined)?.trim() ??
              "",
          )
          .filter((l) => l.length > 4);
        if (lines.length > 0) return lines;
      }
    } catch {
      // fall through
    }
  }

  // rfspager.app is Livewire SSR — message is in <th scope="row">, prefixed with a date.
  const DATE_PREFIX = /^\d{1,2}\s+\w+\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+/;
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const lines: string[] = [];
  for (const row of rows) {
    const thMatch = row[1].match(/<th\s[^>]*scope=["']row["'][^>]*>([\s\S]*?)<\/th>/i);
    if (!thMatch) continue;
    const inner = thMatch[1]
      .replace(/<div[^>]*class="[^"]*md:hidden[^"]*"[^>]*>[\s\S]*?<\/div>/i, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();
    const raw = inner.replace(DATE_PREFIX, "").trim();
    if (isValidPagerLine(raw)) lines.push(raw);
    if (lines.length >= limit) break;
  }
  return lines;
}

async function fetchTelegram(limit: number): Promise<string[]> {
  if (!TG_API_ID || !TG_API_HASH || !TG_SESSION || !TG_GROUP) {
    console.log("  Telegram not configured — skipping");
    return [];
  }
  let TelegramClient: typeof import("telegram").TelegramClient;
  let StringSession: typeof import("telegram/sessions").StringSession;
  try {
    ({ TelegramClient } = await import("telegram"));
    ({ StringSession } = await import("telegram/sessions"));
  } catch {
    console.error("  `telegram` package not found");
    return [];
  }
  const client = new TelegramClient(new StringSession(TG_SESSION), TG_API_ID, TG_API_HASH, { connectionRetries: 3 });
  await client.connect();
  try {
    const msgs = await client.getMessages(TG_GROUP, { limit });
    return [...msgs]
      .reverse()
      .map((m) => {
        const raw = (m.message as string | undefined)?.trim() ?? "";
        const match = raw.match(/^Message:\s*(.+)$/m);
        return match ? match[1].trim() : raw;
      })
      .filter(isValidPagerLine);
  } finally {
    await client.disconnect();
  }
}

// ── board calls ───────────────────────────────────────────────────────────────

async function clearBoard() {
  const res = await fetch(`${BOARD}/api/incidents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/incidents → HTTP ${res.status}`);
  const data = (await res.json()) as { cleared: boolean };
  if (!data.cleared) throw new Error("Board did not confirm clear");
}

async function postLines(lines: string[], source: string) {
  if (!lines.length) {
    console.log(`  [${source}] nothing to post`);
    return;
  }
  const res = await fetch(`${BOARD}/api/incidents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: lines }),
  });
  const data = (await res.json()) as {
    added?: { type: string; incidentNo: string; id: string; location: string; unit: string }[];
    error?: string;
  };
  if (!res.ok || data.error) {
    console.error(`  [${source}] post failed:`, data.error ?? res.status);
    return;
  }
  const added = data.added ?? [];
  console.log(`  [${source}] ${added.length} incident(s) added:`);
  for (const inc of added) {
    const label = inc.type || "?";
    const num = inc.incidentNo || inc.id;
    const where = inc.location || inc.unit || "—";
    console.log(`    • [${label}] ${num}  ${where}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Board: ${BOARD}\n`);

  console.log("1/4  Flushing sample data…");
  await clearBoard();
  console.log("     ✓ board cleared\n");

  console.log("2/4  Fetching last 5 from PagerMon (cmssweb)…");
  const pmLines = await fetchPagerMon(5);
  console.log(`     got ${pmLines.length} line(s)\n`);

  console.log("3/4  Fetching last 5 from rfspager.app…");
  const rfsLines = await fetchRfsPager(5);
  console.log(`     got ${rfsLines.length} line(s)\n`);

  console.log("4/4  Fetching last 5 from Telegram (GoulburnScan Pager)…");
  const tgLines = await fetchTelegram(5);
  console.log(`     got ${tgLines.length} line(s)\n`);

  console.log("Posting to board…");
  await postLines(pmLines, "pagermon");
  await postLines(rfsLines, "rfspager");
  await postLines(tgLines, "telegram");

  console.log("\nDone — reload the board to see live data.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
