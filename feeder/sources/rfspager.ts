import type { PostFn } from "../poster";
import { isValidPagerLine } from "../filter";

const PAGE_URL = "https://rfspager.app/pager";
// Keep a rolling set of seen messages to avoid re-posting on each poll.
const seen = new Set<string>();

export async function pollRfsPager(post: PostFn): Promise<void> {
  // Seed the seen Set from the current page so a restart doesn't re-post
  // everything already on the board.
  try {
    const res = await fetch(PAGE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (res.ok) {
      const lines = extractFromHtml(await res.text());
      lines.forEach((l) => seen.add(l));
      console.log(`[rfspager] cursor seeded with ${seen.size} existing message(s)`);
    }
  } catch {
    // non-fatal — worst case we re-post on first tick
  }

  async function tick() {
    try {
      const res = await fetch(PAGE_URL, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      const lines = extractFromHtml(html);
      const fresh = lines.filter((l) => !seen.has(l));
      fresh.forEach((l) => seen.add(l));

      // Prune the seen set so it doesn't grow forever.
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

// Matches the human-readable date prefix rfspager prepends to each raw line:
//   "15 June 2026 20:43:26 CCCOORA - ..."
const DATE_PREFIX_RE = /^\d{1,2}\s+\w+\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+/;

function extractFromHtml(html: string): string[] {
  // rfspager.app is a Laravel Livewire app — messages are SSR'd into <th scope="row"> cells.
  // Structure: <tr> → <td>date</td> <td>capcode</td> <td>agency</td> <td>brigade</td>
  //                    <th scope="row">DD Month YYYY HH:MM:SS RAW_PAGER_LINE</th>
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const lines: string[] = [];

  for (const row of rows) {
    // The message cell is a <th scope="row">, not a <td>.
    const thMatch = row[1].match(/<th\s[^>]*scope=["']row["'][^>]*>([\s\S]*?)<\/th>/i);
    if (!thMatch) continue;

    // Strip the mobile-only header div and any remaining tags.
    const inner = thMatch[1]
      .replace(/<div[^>]*class="[^"]*md:hidden[^"]*"[^>]*>[\s\S]*?<\/div>/i, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .trim();

    // Strip the prepended human-readable date ("15 June 2026 20:43:26 ").
    const raw = inner.replace(DATE_PREFIX_RE, "").trim();
    if (isValidPagerLine(raw)) lines.push(raw);
  }

  return lines;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
