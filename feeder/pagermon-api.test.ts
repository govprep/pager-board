// Tests for reading a public PagerMon instance over its REST API instead of
// its Socket.IO broadcast.
//
// Run: npm test
//
// Why this exists: on 2026-09-07 forcequit.xyz's Cloudflare began answering
// every request to the `/socket.io/` path with the WAF block page, from the
// residential exit our proxy uses as much as from anywhere else — steady across
// query strings, a full Chrome header set, cookies from a prior page load,
// HTTP/1.1 and h2, and the path re-cased. Nothing else on the zone is touched:
// `/` is 200, `/api/messages` is 200, a missing path still 404s. So the socket
// is gone for good and the same messages are read from the JSON API instead.
//
// Two things about that API shape the code being pinned here, and both were
// measured against the live host rather than assumed:
//
//   - It answers newest-first and ignores `since`, so the cursor is ours to
//     keep. `selectNew` is that cursor: ids above the mark, back in the order
//     they were paged.
//   - It carries ~21.5 messages/hour, so one `limit=50` page is over two hours
//     of traffic and a 60s poll cannot outrun it.
//
// The instance's own policy (PagerMon's `ignore` flag, the project-wide SES
// bar) still has to apply on this path, so it goes through the same `toLine`
// the socket used rather than a second copy of those rules.

import test from "node:test";
import assert from "node:assert/strict";

import { apiUrl, selectNew, makeApiPoller } from "./sources/pagermon-api";
import type { LiveInstance, PagerMonLiveMessage } from "./sources/pagermon-live";
import type { PagerLine } from "./poster";

const inst: LiveInstance = {
  label: "test",
  baseUrl: "https://pager.example",
  transport: "api",
};

/** A message as the API returns one — only the fields we read. */
function msg(id: number, over: Partial<PagerMonLiveMessage> = {}): PagerMonLiveMessage & { id: number } {
  return {
    id,
    message: `page ${id}`,
    timestamp: 1_757_000_000 + id,
    agency: "FRNSW",
    address: "0125111",
    alias: "251 Cardiff",
    ...over,
  };
}

/** Collect what the poller posts, standing in for poster.ts. */
function recorder() {
  const posted: { lines: PagerLine[]; source: string }[] = [];
  return {
    posted,
    post: async (lines: PagerLine[], source: string) => {
      posted.push({ lines, source });
    },
  };
}

/** A fetcher that answers with the given pages in order, newest id first. */
function feed(...pages: (PagerMonLiveMessage & { id: number })[][]) {
  const calls: { url: string; agent?: unknown }[] = [];
  let n = 0;
  return {
    calls,
    fetchJson: async (url: string, init: { agent?: unknown }) => {
      calls.push({ url, agent: init.agent });
      const page = pages[Math.min(n, pages.length - 1)];
      n++;
      return { messages: [...page].sort((a, b) => b.id - a.id) };
    },
  };
}

test("the poll URL is the instance's own /api/messages with a limit", () => {
  assert.equal(
    apiUrl("https://pager.example", 50),
    "https://pager.example/api/messages?limit=50",
  );
});

test("a trailing slash on the base URL does not double up", () => {
  assert.equal(
    apiUrl("https://pager.example/", 50),
    "https://pager.example/api/messages?limit=50",
  );
});

test("selectNew keeps only messages above the cursor", () => {
  const { fresh } = selectNew([msg(7), msg(6), msg(5)], 5);
  assert.deepEqual(fresh.map((m) => m.id), [6, 7]);
});

test("selectNew hands them back oldest first", () => {
  // The API answers newest-first; the board applies updates in arrival order,
  // so a later page must not be written before the one it supersedes.
  const { fresh } = selectNew([msg(9), msg(8), msg(7)], 0);
  assert.deepEqual(fresh.map((m) => m.id), [7, 8, 9]);
});

test("selectNew reports the highest id it saw so the cursor can advance", () => {
  assert.equal(selectNew([msg(9), msg(8)], 0).maxId, 9);
});

test("selectNew leaves the cursor alone when the page holds nothing new", () => {
  assert.equal(selectNew([msg(4), msg(3)], 9).maxId, 9);
});

test("the first poll seeds the cursor and posts nothing", async () => {
  // A socket only ever delivered what arrived after it connected. Replaying a
  // page of backlog on every restart would be a burst of Slack posts and phone
  // pushes for jobs the board has long since seen.
  const rec = recorder();
  const f = feed([msg(3), msg(2), msg(1)], [msg(4), msg(3), msg(2), msg(1)]);
  const poller = makeApiPoller(rec.post, inst, { fetchJson: f.fetchJson });

  await poller.tick();
  assert.equal(rec.posted.length, 0, "seeding must not post");

  await poller.tick();
  assert.equal(rec.posted.length, 1);
  assert.deepEqual(rec.posted[0].lines.map((l) => l.raw), ["page 4"]);
  assert.equal(rec.posted[0].source, "test");
});

test("a message already seen is not posted twice", async () => {
  const rec = recorder();
  const f = feed([msg(1)], [msg(2), msg(1)], [msg(2), msg(1)]);
  const poller = makeApiPoller(rec.post, inst, { fetchJson: f.fetchJson });

  await poller.tick(); // seed
  await poller.tick(); // 2 is new
  await poller.tick(); // nothing new

  assert.equal(rec.posted.length, 1, "the third poll had nothing to post");
  assert.deepEqual(rec.posted[0].lines.map((l) => l.raw), ["page 2"]);
});

test("the instance's own policy still applies on this path", async () => {
  // PagerMon's `ignore` is an operator having muted that capcode, and SES
  // traffic never reaches the board. Both are recorded raw either way.
  const rec = recorder();
  const f = feed(
    [msg(1)],
    [msg(4, { agency: "SES" }), msg(3, { ignore: 1 }), msg(2), msg(1)],
  );
  const poller = makeApiPoller(rec.post, inst, { fetchJson: f.fetchJson });

  await poller.tick();
  await poller.tick();

  const lines = rec.posted[0].lines;
  assert.deepEqual(lines.map((l) => l.raw), ["page 2", "page 3", "page 4"]);
  assert.equal(lines[0].boardEligible, true, "an ordinary page belongs on the board");
  assert.equal(lines[1].boardEligible, false, "ignore means muted");
  assert.equal(lines[2].boardEligible, false, "SES never reaches the board");
});

test("the instance's proxy agent reaches the request", async () => {
  // The whole reason this instance is read at all: its zone refuses this
  // machine's IP, so every call has to leave through the tunnel. An agent that
  // does not arrive is a request that 403s.
  const rec = recorder();
  const f = feed([msg(1)]);
  const agent = { marker: "socks" };
  const poller = makeApiPoller(rec.post, inst, { fetchJson: f.fetchJson }, agent);

  await poller.tick();

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].agent, agent, "must be the same object, not a copy");
  assert.equal(f.calls[0].url, "https://pager.example/api/messages?limit=50");
});

test("a failed poll leaves the cursor where it was", async () => {
  // Advancing past messages we never read would drop them silently — the next
  // poll has no way to know it skipped anything, because the cursor is ours.
  const rec = recorder();
  let calls = 0;
  const fetchJson = async () => {
    calls++;
    if (calls === 2) throw new Error("HTTP 403");
    return { messages: [msg(2), msg(1)] };
  };
  const poller = makeApiPoller(rec.post, inst, { fetchJson });

  await poller.tick(); // seed at 2
  await poller.tick(); // throws
  await poller.tick(); // recovers, still nothing newer than 2

  assert.deepEqual(rec.posted, [], "nothing newer than the seed ever arrived");
});

test("a poll that throws does not take the feeder down", async () => {
  const rec = recorder();
  const poller = makeApiPoller(rec.post, inst, {
    fetchJson: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await poller.tick();
  assert.deepEqual(rec.posted, []);
});
