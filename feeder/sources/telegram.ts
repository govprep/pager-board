import type { PostFn, PagerLine } from "../poster";
import { passesBoardFilter } from "../../lib/filter";

// Pull the pager line out of the Telegram wrapper, keeping the district/station
// header as origin metadata for /raw. Everything extracted is recorded in the
// raw feed — the board filter runs in poster.ts.
//
// Format: "DISTRICT - STATION\nMessage: {pager line}". The header is only
// trusted when the "Message:" marker is actually present; without it the whole
// text is the pager line and there's no header to read.
function extractPagerLine(
  raw: string,
): { line: string; agency: string | null; origin: string | null } | null {
  const m = raw.match(/^Message:\s*(.+)$/m);
  if (!m) {
    const line = raw.trim();
    return line ? { line, agency: null, origin: null } : null;
  }

  const line = m[1].trim();
  if (!line) return null;

  const header = raw.slice(0, m.index ?? 0).trim().split(/\r?\n/)[0] ?? "";
  const parts = header.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  return {
    line,
    agency: parts[0] ?? null,
    origin: parts.length > 1 ? parts.slice(1).join(" - ") : null,
  };
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

  // Seed the cursor and post the recent valid messages to populate the board,
  // matching pagermon/rfspager. Without this, telegram stays blank on startup
  // and only forwards pages that arrive after the feeder boots.
  let lastMsgId = 0;
  try {
    const seed = await client.getMessages(group, { limit: 50 });
    if (seed.length) lastMsgId = Math.max(...seed.map((m) => m.id));

    const lines: PagerLine[] = [...seed]
      .reverse() // oldest-first so ingest order is chronological
      .flatMap((m) => {
        const parsed = extractPagerLine((m.message as string | undefined) ?? "");
        if (!parsed) return [];
        const receivedAt = m.date
          ? new Date((m.date as number) * 1000).toISOString()
          : undefined;
        return [{
          raw: parsed.line,
          receivedAt,
          agency: parsed.agency,
          origin: parsed.origin,
        }];
      });

    // Everything is recorded raw; only the newest 30 board-worthy lines are let
    // onto the board, so a first-ever run doesn't fire a Slack post and a phone
    // push for the whole backlog. Walk newest-first to spend the budget there.
    let budget = 30;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!passesBoardFilter(lines[i].raw)) continue;
      if (budget > 0) budget--;
      else lines[i].boardEligible = false;
    }

    if (lines.length) await post(lines, "telegram");
    console.log(`[telegram] cursor seeded at msg ${lastMsgId}, posted ${lines.length} recent message(s)`);
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
      const lines: PagerLine[] = [...msgs]
        .reverse()
        .flatMap((m) => {
          const parsed = extractPagerLine((m.message as string | undefined) ?? "");
          if (!parsed) return [];
          const receivedAt = m.date
            ? new Date((m.date as number) * 1000).toISOString()
            : undefined;
          return [{
            raw: parsed.line,
            receivedAt,
            agency: parsed.agency,
            origin: parsed.origin,
          }];
        });

      await post(lines, "telegram");
    } catch (err) {
      console.error("[telegram]", err instanceof Error ? err.message : err);
    }
  }

  tick();
  setInterval(tick, 30_000);
}
