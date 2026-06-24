import type { PostFn, PagerLine } from "../poster";
import { isValidPagerLine } from "../filter";

const PAGE_URL = "https://rfspager.app/pager";
const seen = new Set<string>();

export async function pollRfsPager(post: PostFn): Promise<void> {
  try {
    const res = await fetch(PAGE_URL, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const items = extractFromHtml(await res.text());
      items.forEach((item) => seen.add(item.raw));
      if (items.length) await post(items.slice(0, 30), "rfspager");
      console.log(`[rfspager] cursor seeded with ${seen.size} existing message(s), posted ${Math.min(items.length, 30)}`);
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
  setInterval(tick, 90_000);
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9",
};

// "15 June 2026 20:43:26 "
const DATE_PREFIX_RE = /^(\d{1,2})\s+(\w+)\s+(\d{4})\s+(\d{2}:\d{2}:\d{2})\s+/;

function parseDatePrefix(prefix: string): string | undefined {
  const m = prefix.match(DATE_PREFIX_RE);
  if (!m) return undefined;
  // "June 15 2026 20:43:26" is parsed reliably by V8
  const d = new Date(`${m[2]} ${m[1]} ${m[3]} ${m[4]}`);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
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

    const receivedAt = parseDatePrefix(inner);
    // rfspager.app renders each message twice: a desktop row prefixed with the
    // date/time, and a stacked mobile clone with no prefix. Ingest only the
    // dated desktop row — otherwise the dateless clone parses to the same id and
    // overwrites the real timestamp with now() on upsert, scrambling the order.
    if (!receivedAt) continue;
    const raw = inner.replace(DATE_PREFIX_RE, "").trim();
    if (isValidPagerLine(raw)) lines.push({ raw, receivedAt });
  }

  return lines;
}
