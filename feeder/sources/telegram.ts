import type { PostFn } from "../poster";
import { isValidPagerLine } from "../filter";

function extractPagerLine(raw: string): string | null {
  // Format: "DISTRICT - STATION\nMessage: {pager line}"
  const m = raw.match(/^Message:\s*(.+)$/m);
  const line = m ? m[1].trim() : raw.trim();
  return isValidPagerLine(line) ? line : null;
}

export async function pollTelegram(post: PostFn): Promise<void> {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH ?? "";
  const sessionStr = process.env.TG_SESSION ?? "";
  const group = process.env.TG_GROUP ?? "";

  if (!apiId || !apiHash || !sessionStr || !group) {
    console.warn(
      "[telegram] TG_API_ID, TG_API_HASH, TG_SESSION, TG_GROUP all required — " +
        "run `npm run feeder:auth-telegram` to generate TG_SESSION",
    );
    return;
  }

  // Lazy-import gram.js so the feeder can start even when telegram package isn't installed.
  let TelegramClient: typeof import("telegram").TelegramClient;
  let StringSession: typeof import("telegram/sessions").StringSession;
  try {
    ({ TelegramClient } = await import("telegram"));
    ({ StringSession } = await import("telegram/sessions"));
  } catch {
    console.error("[telegram] `telegram` package not found — run: npm install telegram");
    return;
  }

  const session = new StringSession(sessionStr);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.connect();
  } catch (err) {
    console.error("[telegram] connect failed:", err instanceof Error ? err.message : err);
    return;
  }

  // Initialise cursor to the latest message so we only post new ones going forward.
  let lastMsgId = 0;
  try {
    const seed = await client.getMessages(group, { limit: 1 });
    if (seed.length) lastMsgId = seed[0].id;
  } catch (err) {
    console.error("[telegram] failed to seed cursor:", err instanceof Error ? err.message : err);
  }

  async function tick() {
    try {
      // getMessages with minId returns messages AFTER lastMsgId, newest first.
      const msgs = await client.getMessages(group, {
        limit: 100,
        minId: lastMsgId || undefined,
      });
      if (!msgs.length) return;

      // Update cursor to the highest ID we've seen.
      const maxId = Math.max(...msgs.map((m) => m.id));
      if (maxId > lastMsgId) lastMsgId = maxId;

      // Process oldest-first so the board ingests in chronological order.
      const lines = [...msgs]
        .reverse()
        .map((m) => extractPagerLine((m.message as string | undefined) ?? ""))
        .filter((l): l is string => l !== null);

      await post(lines, "telegram");
    } catch (err) {
      console.error("[telegram]", err instanceof Error ? err.message : err);
    }
  }

  tick();
  setInterval(tick, 30_000);
}
