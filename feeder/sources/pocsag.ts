import type { PostFn } from "../poster";

const BASE_URL = "https://pocsag.net";
const seen = new Set<string>();

export async function pollPocsag(post: PostFn): Promise<void> {
  async function tick() {
    try {
      const res = await fetch(`${BASE_URL}/`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-AU,en;q=0.9",
          Referer: BASE_URL,
        },
      });

      if (res.status === 403) {
        // Site appears to block headless requests. Logged once then silenced.
        console.warn("[pocsag] 403 — site may require login or Cloudflare bypass; skipping this source");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      const lines = extractFromHtml(html);
      const fresh = lines.filter((l) => !seen.has(l));
      fresh.forEach((l) => seen.add(l));
      if (seen.size > 2000) {
        const oldest = [...seen].slice(0, 500);
        oldest.forEach((k) => seen.delete(k));
      }
      if (fresh.length) await post(fresh, "pocsag");
    } catch (err) {
      console.error("[pocsag]", err instanceof Error ? err.message : err);
    }
  }

  tick();
  setInterval(tick, 120_000);
}

function extractFromHtml(html: string): string[] {
  // Try __NEXT_DATA__ first.
  const ndMatch = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]);
      const messages: unknown[] =
        nd?.props?.pageProps?.messages ??
        nd?.props?.pageProps?.pagerMessages ??
        [];
      if (Array.isArray(messages) && messages.length > 0) {
        return messages
          .map((m: unknown) => {
            if (typeof m !== "object" || !m) return null;
            const obj = m as Record<string, unknown>;
            return (
              (obj.message as string | undefined) ??
              (obj.text as string | undefined) ??
              null
            );
          })
          .filter((l): l is string => !!l && l.length > 4);
      }
    } catch {
      // fall through
    }
  }

  // Fallback: generic table parsing — message tends to be the last column.
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const lines: string[] = [];
  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (c) => stripTags(c[1]).trim(),
    );
    // Heuristic: pick the longest cell in each row — usually the message.
    const longest = cells.reduce(
      (best, c) => (c.length > best.length ? c : best),
      "",
    );
    if (longest.length > 10) lines.push(longest);
  }
  return lines;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
