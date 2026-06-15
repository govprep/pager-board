export type PostFn = (lines: string[], source: string) => Promise<void>;

export function makePoster(boardUrl: string): PostFn {
  return async function post(lines: string[], source: string) {
    if (!lines.length) return;
    try {
      const res = await fetch(`${boardUrl}/api/incidents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: lines }),
      });
      const data = await res.json().catch(() => ({}));
      const count: number = (data.added as unknown[])?.length ?? 0;
      if (count) console.log(`[${source}] +${count} incident(s)`);
    } catch (err) {
      console.error(`[${source}] post error:`, err instanceof Error ? err.message : err);
    }
  };
}
