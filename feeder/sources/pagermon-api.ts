import type { PostFn } from "../poster";
import {
  browserHeaders,
  proxyAgentFor,
  toLine,
  type LiveInstance,
  type PagerMonLiveMessage,
} from "./pagermon-live";

// ---------------------------------------------------------------------------
// Reading a public PagerMon instance over its REST API rather than its
// Socket.IO broadcast.
//
// Same host, same messages, same field names — PagerMon serves
// `/api/messages` to the very page that opens the socket. This exists because
// one instance's Cloudflare stopped serving the socket at all:
// pager.forcequit.xyz began answering `/socket.io/` with the WAF block page on
// 2026-09-07, from the residential exit our tunnel uses as much as from
// anywhere else, and steadily — across query strings, a full Chrome header set,
// cookies from a prior page load, HTTP/1.1 and h2, and the path re-cased.
// Nothing else on that zone moved: `/` answers 200, `/api/messages` answers
// 200, a path that doesn't exist still 404s. So the socket is not coming back
// by tuning, and the same traffic is read from the JSON API instead.
//
// Two measured properties of that API shape everything below:
//
//   - It answers newest-first and ignores `since`, so the cursor is ours to
//     keep rather than the server's. `selectNew` is that cursor.
//   - It carries about 21.5 messages/hour. One `limit=50` page is therefore
//     over two hours of traffic, and a 60s poll has no way to outrun it.
//
// The second number is also why this is gentler on the host than what it
// replaces: the socket client this supersedes reconnected thousands of times
// (see the note on `forceNode` in pagermon-live.ts), where this is one small
// GET a minute.
// ---------------------------------------------------------------------------

/** A message as the API returns one. Same shape the socket pushed, plus `id`. */
export interface PagerMonApiMessage extends PagerMonLiveMessage {
  id?: number;
}

interface PagerMonApiResponse {
  messages?: PagerMonApiMessage[];
}

/**
 * How much of the feed one poll asks for.
 *
 * Sized against the host's own rate rather than picked round: 50 messages is
 * two hours of its traffic, so a poll can be late — or a few polls can fail in
 * a row — without anything falling off the end of the page unseen.
 */
export const DEFAULT_LIMIT = 50;

/**
 * How often to poll.
 *
 * This is somebody else's host, so the interval is set by politeness rather
 * than by how stale a page may be — the opposite of the private instance in
 * sources/pagermon.ts, which is ours and polls at 15s. A page arrives here a
 * mean 30s later than the socket would have delivered it, which for a source
 * that carried 1% of the board's volume is the right trade against hammering a
 * host that has just made its position clear.
 */
export const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 30_000;

export function apiUrl(baseUrl: string, limit: number): string {
  return `${baseUrl.replace(/\/$/, "")}/api/messages?limit=${limit}`;
}

/**
 * The messages on a page that we haven't already recorded, oldest first.
 *
 * `maxId` is the cursor's new position — the highest id the page carried, or
 * the old position when the page carried nothing newer. Ordering matters on
 * the way out: the API answers newest-first, and the board applies updates in
 * the order it receives them, so a later page must not be written ahead of the
 * one it supersedes.
 */
export function selectNew(
  messages: PagerMonApiMessage[],
  lastId: number,
): { fresh: PagerMonApiMessage[]; maxId: number } {
  let maxId = lastId;
  const fresh: PagerMonApiMessage[] = [];

  for (const m of messages) {
    const id = Number(m?.id);
    // An id is how this source is deduplicated at all; a message without one
    // would be re-posted on every poll forever.
    if (!Number.isFinite(id)) continue;
    if (id > maxId) maxId = id;
    if (id > lastId) fresh.push(m);
  }

  fresh.sort((a, b) => Number(a.id) - Number(b.id));
  return { fresh, maxId };
}

export interface ApiDeps {
  fetchJson: (
    url: string,
    init: { agent?: unknown; headers: Record<string, string> },
  ) => Promise<unknown>;
}

/**
 * One instance's poller, without the timer.
 *
 * Split from the loop below so the cursor can be tested without a network or a
 * clock — the cursor is the part that can silently lose pages.
 */
export function makeApiPoller(
  post: PostFn,
  inst: LiveInstance,
  deps: ApiDeps,
  agent?: unknown,
  limit: number = DEFAULT_LIMIT,
): { tick: () => Promise<void> } {
  const tag = `[${inst.label}]`;
  const url = apiUrl(inst.baseUrl, limit);
  const headers = { ...browserHeaders(inst.baseUrl), Accept: "application/json" };

  let lastId = 0;
  let seeded = false;

  async function tick(): Promise<void> {
    try {
      const body = (await deps.fetchJson(url, { agent, headers })) as
        | PagerMonApiResponse
        | PagerMonApiMessage[];
      const messages = Array.isArray(body) ? body : (body?.messages ?? []);
      const { fresh, maxId } = selectNew(messages, lastId);

      // The first poll only marks where the feed had got to. A socket delivered
      // nothing that predated it, and replaying a page of backlog on every
      // restart would mean a burst of Slack posts and phone pushes for jobs the
      // board saw hours ago.
      if (!seeded) {
        lastId = maxId;
        seeded = true;
        console.log(`${tag} polling ${inst.baseUrl}/api/messages, cursor seeded at id ${maxId}`);
        return;
      }

      lastId = maxId;
      if (!fresh.length) return;

      const lines = fresh
        .map((m) => toLine(m, inst))
        .filter((l): l is NonNullable<typeof l> => l !== null);
      if (lines.length) await post(lines, inst.label);
    } catch (err) {
      // The cursor is deliberately untouched here: advancing past messages we
      // never read would drop them silently, and nothing downstream could tell.
      console.error(`${tag} poll failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { tick };
}

/** Read one PagerMon instance's API on a timer. Recovers on its own. */
export async function pollPagerMonApi(post: PostFn, inst: LiveInstance): Promise<void> {
  const tag = `[${inst.label}]`;

  if (inst.disabled) {
    console.warn(`${tag} disabled — ${inst.disabled}`);
    return;
  }

  // Same rule as the socket path: an instance we can only reach through a proxy
  // is one where an unusable proxy means not connecting, rather than falling
  // back to a direct call that just 403s on a loop.
  let agent: unknown;
  if (inst.proxy) {
    try {
      agent = await proxyAgentFor(inst.proxy);
    } catch (err) {
      console.error(
        `${tag} not polling — unusable proxy:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
    console.log(`${tag} routing via ${inst.proxy}`);
  }

  const { tick } = makeApiPoller(post, inst, { fetchJson }, agent);
  await tick();
  setInterval(() => void tick(), pollMs());
}

function pollMs(): number {
  const raw = Number(process.env.FEEDER_API_POLL_MS);
  return Number.isFinite(raw) && raw >= MIN_POLL_MS ? raw : DEFAULT_POLL_MS;
}

/**
 * GET one JSON document, optionally through a SOCKS agent.
 *
 * Node's global `fetch` is undici, which takes a `dispatcher` and ignores an
 * `http.Agent` outright — so handing it what `socks-proxy-agent` builds would
 * send the request direct and straight into the 403 this whole path exists to
 * avoid, with nothing in the log to say so. node:https takes the agent, so the
 * request goes through the tunnel or not at all.
 */
async function fetchJson(
  url: string,
  init: { agent?: unknown; headers: Record<string, string> },
): Promise<unknown> {
  const https = await import("node:https");
  const zlib = await import("node:zlib");

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: init.headers,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agent: init.agent as any,
        timeout: 20_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            const raw = Buffer.concat(chunks);
            const enc = (res.headers["content-encoding"] ?? "").toString();
            const body = enc.includes("gzip")
              ? zlib.gunzipSync(raw)
              : enc.includes("deflate")
                ? zlib.inflateSync(raw)
                : enc.includes("br")
                  ? zlib.brotliDecompressSync(raw)
                  : raw;
            resolve(JSON.parse(body.toString("utf8")));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}
