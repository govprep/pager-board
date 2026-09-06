import type { PostFn, PagerLine } from "../poster";
import { passesBoardFilter } from "../../lib/filter";

const PAGE_URL = "https://rfspager.app/pager";

// On startup the whole page is "new" to us. Everything is recorded in the raw
// feed, but only this many board-worthy lines are allowed onto the board —
// otherwise a first-ever run fires a Slack post and a phone push for every row
// on the page.
const SEED_BOARD_LIMIT = 30;

/**
 * Bar everything past the first `SEED_BOARD_LIMIT` board-worthy lines from the
 * board. Junk doesn't count against the budget, so the board seeds with the
 * same 30 incidents it always did — the rest is still recorded raw.
 */
function capBoardSeed(items: PagerLine[]): PagerLine[] {
  let budget = SEED_BOARD_LIMIT;
  return items.map((item) => {
    if (item.boardEligible === false || !passesBoardFilter(item.raw)) return item;
    if (budget > 0) {
      budget--;
      return item;
    }
    return { ...item, boardEligible: false };
  });
}
const seen = new Set<string>();

export async function pollRfsPager(post: PostFn): Promise<void> {
  try {
    const res = await fetch(PAGE_URL, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const items = extractFromHtml(await res.text());
      items.forEach((item) => seen.add(item.raw));
      if (items.length) await post(capBoardSeed(items), "rfspager");
      console.log(`[rfspager] cursor seeded with ${seen.size} existing message(s), posted ${items.length}`);
    }
  } catch {
    // non-fatal — worst case we re-post on first tick
  }

  async function tick() {
    try {
      const res = await fetch(PAGE_URL, { headers: BROWSER_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const items = extractFromHtml(await res.text());
      const fresh = items.filter((item) => !seen.has(item.raw));
      fresh.forEach((item) => seen.add(item.raw));

      if (seen.size > 2000) {
        const oldest = [...seen].slice(0, 500);
        oldest.forEach((k) => seen.delete(k));
      }

      if (fresh.length) await post(fresh, "rfspager");
    } catch (err) {
      console.error("[rfspager]", err instanceof Error ? err.message : err);
    }
  }

  tick();
  setInterval(tick, pollMs());
}

// Left at 90s deliberately. This is someone else's page being scraped, and the
// measurements don't justify leaning on it harder: over a week it was the first
// source to reach us for 3% of jobs, and dropping it altogether would have
// delayed only 24 of 1306 jobs (median 0s) while losing 24 outright. Its value
// is coverage of the pages nothing else hears, not speed — and those it will
// carry whether we ask every 45s or every 90s.
//
// RFSPAGER_POLL_MS is here for the case that changes, with a 30s floor so a
// typo can't turn the scraper into a hammer.
const DEFAULT_POLL_MS = 90_000;

function pollMs(): number {
  const raw = Number(process.env.RFSPAGER_POLL_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_POLL_MS;
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9",
};

// Legacy in-message prefix, e.g. "15 June 2026 20:43:26 ". Older rows still
// carry it; newer ones don't (the time moved to the row's first column).
const DATE_PREFIX_RE = /^(\d{1,2})\s+(\w+)\s+(\d{4})\s+(\d{2}:\d{2}:\d{2})\s+/;

function parseDatePrefix(prefix: string): string | undefined {
  const m = prefix.match(DATE_PREFIX_RE);
  if (!m) return undefined;
  // "June 15 2026 20:43:26" is parsed reliably by V8
  const d = new Date(`${m[2]} ${m[1]} ${m[3]} ${m[4]}`);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Each row's first <td> holds the canonical local time, "2026-06-28 09:45".
const ROW_TIME_RE = /<td[^>]*>\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*<\/td>/i;

function parseRowTime(rowHtml: string): string | undefined {
  const m = rowHtml.match(ROW_TIME_RE);
  if (!m) return undefined;
  // Build from parts as local time, matching parseDatePrefix's interpretation.
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Strip tags and decode entities from a table cell. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

// Each row's <td>s are: Date Time | Capcode | Agency | Brigade. The message
// itself lives in the <th scope="row">. The three metadata columns are what
// gives /raw a real origin ("0010744", "Lower Hunter",
// "Williamtown/Salt Ash Brigade") instead of a bare station code.
function rowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
}

function extractFromHtml(html: string): PagerLine[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const lines: PagerLine[] = [];

  for (const row of rows) {
    const thMatch = row[1].match(/<th\s[^>]*scope=["']row["'][^>]*>([\s\S]*?)<\/th>/i);
    if (!thMatch) continue;

    const inner = thMatch[1]
      .replace(/<div[^>]*class="[^"]*md:hidden[^"]*"[^>]*>[\s\S]*?<\/div>/i, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .trim();

    // Prefer the legacy in-message prefix (older rows); fall back to the row's
    // first <td>, where rfspager.app now puts the time for new-format rows.
    const receivedAt = parseDatePrefix(inner) ?? parseRowTime(row[0]);
    const raw = inner.replace(DATE_PREFIX_RE, "").trim();
    if (!raw) continue;

    // [0] is the timestamp we already parsed above; the rest is the origin.
    const [, capcode, agency, origin] = rowCells(row[0]);

    // Every line goes through — the board filter now lives in poster.ts so the
    // raw feed sees what the board rejects. A row with no usable time still
    // gets recorded, but is barred from the board: stamping it now() would
    // scramble the ordering.
    lines.push({
      raw,
      receivedAt,
      boardEligible: receivedAt != null,
      capcode,
      agency,
      origin,
    });
  }

  return lines;
}
