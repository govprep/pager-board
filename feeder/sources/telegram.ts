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

/** How often to ask Telegram for anything new. */
export const TG_POLL_MS = 30_000;

/**
 * How long a single Telegram call may run before we stop waiting on it.
 *
 * gram.js defaults `reconnectRetries` to Infinity, so a sender whose transport
 * has gone retries forever and never rejects the requests already queued on it.
 * Without this bound the await simply never returns: nothing throws, so nothing
 * is caught, so nothing is logged. That is exactly how this source went silent
 * for two hours while every other feed stayed current.
 */
export const TG_CALL_TIMEOUT_MS = 60_000;

/** First wait after a failure, then doubling. */
export const TG_BACKOFF_BASE_MS = 60_000;
/** Ceiling on the wait, so a long outage settles at 2 attempts an hour. */
export const TG_BACKOFF_MAX_MS = 30 * 60_000;
/** Added to a flood wait, since coming back the instant it lapses re-earns it. */
export const TG_FLOOD_MARGIN_MS = 30_000;

/**
 * Seconds Telegram wants us to wait, or null if this isn't a flood error.
 *
 * gram.js raises FloodWaitError with a `.seconds` field, but the same condition
 * also reaches us as a plain Error when it is thrown from the connection
 * handshake, so the message is parsed as a fallback.
 */
export function floodWaitSeconds(err: unknown): number | null {
  const e = err as { seconds?: unknown; message?: unknown } | null;
  if (e && typeof e.seconds === "number" && Number.isFinite(e.seconds)) return e.seconds;
  const msg = typeof e?.message === "string" ? e.message : String(err ?? "");
  const m = msg.match(/wait of (\d+) seconds is required/i);
  return m ? Number(m[1]) : null;
}

/** Doubling backoff, from base to ceiling. */
export function nextBackoffMs(prevMs: number): number {
  if (prevMs <= 0) return TG_BACKOFF_BASE_MS;
  return Math.min(prevMs * 2, TG_BACKOFF_MAX_MS);
}

/** The two timer calls this module needs, so tests can drive them off a clock. */
export interface TimerApi {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: TimerApi = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Reject if `p` hasn't settled within `ms`.
 *
 * The underlying promise is left to its fate — a wedged gram.js call may never
 * settle at all — so its rejection is swallowed to stop an orphan surfacing as
 * an unhandled rejection and taking the whole feeder down with it.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  timers: TimerApi = realTimers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = timers.setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        timers.clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        timers.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface TelegramPollerDeps {
  /** Build a client and connect it. Seeding happens on the first success only. */
  connect: () => Promise<void>;
  /** One round trip: fetch since the cursor and post whatever arrived. */
  poll: () => Promise<void>;
  /** Destroy the client, which is the only thing that stops gram.js pinging. */
  teardown: () => Promise<void>;
  now: () => number;
  timeoutMs: number;
  log: (msg: string) => void;
  timers?: TimerApi;
}

/**
 * Supervise the poll loop.
 *
 * The failure this exists for is a feedback loop, not a dropped connection.
 * gram.js pings on its own timer; when the ping times out it calls
 * `_sender.reconnect()`, and each reconnect issues an InvokeWithLayer. At one
 * ping per 30s that is ~120 connection attempts an hour, which is enough for
 * Telegram to impose a flood wait — and since the retry ignores the wait and
 * comes straight back, the penalty is continuously renewed. Observed in
 * production as a 452-second wait that the client could never outlast, with no
 * socket to any Telegram DC and no error in our logs.
 *
 * So the recovery here is to go quiet rather than to try harder: any failure
 * destroys the client, which is what stops the internal ping loop, and nothing
 * reconnects until the backoff has elapsed. That bounds us to at most one
 * connection attempt per minute, decaying to one per half hour — and a flood
 * wait is honoured in full, with a margin, because returning the instant it
 * lapses simply earns another.
 */
export function makeTelegramPoller(deps: TelegramPollerDeps) {
  const { connect, poll, teardown, now, timeoutMs, log, timers = realTimers } = deps;

  let connected = false;
  let inFlight = false;
  let backoffMs = 0;
  let nextAttemptAt = 0;

  async function standDown(err: unknown): Promise<void> {
    // Destroying is the point: while the client lives it keeps pinging and
    // reconnecting underneath us, which is what causes the flood in the first
    // place. Guarded, because destroy() on a wedged client can hang too.
    try {
      await withTimeout(teardown(), timeoutMs, "destroy", timers);
    } catch {
      // Nothing useful to do — the reference is dropped either way.
    }
    connected = false;

    const flood = floodWaitSeconds(err);
    backoffMs =
      flood !== null
        ? Math.max(flood * 1000 + TG_FLOOD_MARGIN_MS, backoffMs)
        : nextBackoffMs(backoffMs);
    nextAttemptAt = now() + backoffMs;

    const why = err instanceof Error ? err.message : String(err);
    log(
      flood !== null
        ? `[telegram] flood wait ${flood}s — staying off for ${Math.round(backoffMs / 1000)}s`
        : `[telegram] ${why} — reconnecting in ${Math.round(backoffMs / 1000)}s`,
    );
  }

  async function tick(): Promise<void> {
    // A call already outstanding means the last tick hasn't timed out yet.
    // Stacking another on a wedged sender only queues work that will never run.
    if (inFlight) return;
    inFlight = true;
    try {
      if (!connected) {
        if (now() < nextAttemptAt) return;
        await withTimeout(connect(), timeoutMs, "connect", timers);
        connected = true;
        log("[telegram] connected");
      }
      await withTimeout(poll(), timeoutMs, "getMessages", timers);
      // Completing a round trip is the only success signal, and an empty result
      // counts — so a quiet group is never mistaken for a broken one. Note this
      // is deliberately not reset on connect: a host that accepts the
      // connection but can't serve data would otherwise sit at the base wait
      // forever, retrying every minute instead of backing off.
      backoffMs = 0;
    } catch (err) {
      await standDown(err);
    } finally {
      inFlight = false;
    }
  }

  return { tick };
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

  let client: InstanceType<typeof TelegramClient> | null = null;
  let lastMsgId = 0;
  let seeded = false;

  function toLines(msgs: { id: number; message?: unknown; date?: unknown }[]): PagerLine[] {
    return msgs.flatMap((m) => {
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
  }

  // Seed the cursor and post the recent valid messages to populate the board,
  // matching pagermon/rfspager. Without this, telegram stays blank on startup
  // and only forwards pages that arrive after the feeder boots.
  //
  // Runs once per process, not once per connect: a reconnect keeps the cursor
  // it already has, so recovering from a flood wait doesn't replay 50 messages
  // onto the board and fire a Slack post and a phone push for each one.
  async function seed(c: InstanceType<typeof TelegramClient>) {
    const recent = await c.getMessages(group, { limit: 50 });
    if (recent.length) lastMsgId = Math.max(...recent.map((m) => m.id));

    const lines = toLines([...recent].reverse()); // oldest-first for chronological ingest

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
    console.log(
      `[telegram] cursor seeded at msg ${lastMsgId}, posted ${lines.length} recent message(s)`,
    );
  }

  async function connect() {
    // autoReconnect off and a slow retryDelay keep gram.js from redialling
    // behind our back; reconnection is this module's decision, on its backoff.
    const c = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
      connectionRetries: 3,
      retryDelay: 5_000,
      autoReconnect: false,
      floodSleepThreshold: 60,
    });
    await c.connect();
    client = c;
    if (!seeded) {
      await seed(c);
      seeded = true;
    }
  }

  async function poll() {
    const c = client;
    if (!c) throw new Error("not connected");

    // getMessages with minId returns messages AFTER lastMsgId, newest first.
    const msgs = await c.getMessages(group, {
      limit: 100,
      minId: lastMsgId || undefined,
    });
    if (!msgs.length) return;

    // Update cursor to the highest ID we've seen.
    const maxId = Math.max(...msgs.map((m) => m.id));
    if (maxId > lastMsgId) lastMsgId = maxId;

    // Process oldest-first so the board ingests in chronological order.
    const lines = toLines([...msgs].reverse());
    await post(lines, "telegram");
  }

  async function teardown() {
    const c = client;
    client = null;
    if (c) await c.destroy();
  }

  const poller = makeTelegramPoller({
    connect,
    poll,
    teardown,
    now: () => Date.now(),
    timeoutMs: TG_CALL_TIMEOUT_MS,
    log: (msg) => console.warn(msg),
  });

  void poller.tick();
  setInterval(() => void poller.tick(), TG_POLL_MS);
}
