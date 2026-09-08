// Regression tests for the Telegram poller's reconnection policy.
//
// The bug these exist for was a feedback loop, not a dropped connection.
// gram.js pings on its own timer; when the ping times out it calls
// `_sender.reconnect()`, and every reconnect issues an InvokeWithLayer. At one
// ping per 30s that is ~120 connection attempts an hour, which is enough for
// Telegram to impose a flood wait — and because the retry ignores the wait and
// comes straight back, the penalty is renewed forever. Production showed a
// 452-second wait the client could never outlast, zero sockets to any Telegram
// DC, and not one error in our logs: `getMessages` was queued on a sender that
// never rejected, so the poller's own try/catch never fired.
//
// The tests therefore guard two things that pull in opposite directions:
// failures must trigger recovery, and recovery must never become a storm.

import test from "node:test";
import assert from "node:assert/strict";

import {
  makeTelegramPoller,
  floodWaitSeconds,
  nextBackoffMs,
  TG_BACKOFF_BASE_MS,
  TG_BACKOFF_MAX_MS,
  TG_CALL_TIMEOUT_MS,
  TG_FLOOD_MARGIN_MS,
  TG_POLL_MS,
} from "./sources/telegram";

/** A promise that never settles — what a wedged gram.js sender hands back. */
function hang(): Promise<void> {
  return new Promise<void>(() => {});
}

/** Let already-queued promise callbacks run. */
const flush = () => new Promise((r) => setImmediate(r));

interface Harness {
  tick: () => Promise<void>;
  advance: (ms: number) => void;
  connects: number;
  teardowns: number;
  logs: string[];
}

/**
 * Drive the poller off a fake clock.
 *
 * The waits under test are minutes long, so the timeout timer has to be fake
 * too — otherwise asserting that we stay off Telegram for 452 seconds would
 * take 452 seconds.
 */
function harness(poll: () => Promise<void>, connect?: () => Promise<void>): Harness {
  let clock = 0;
  let seq = 0;
  const pending = new Map<number, { due: number; cb: () => void }>();

  const h: Harness = {
    tick: async () => {},
    advance: (ms) => {
      clock += ms;
      for (const [id, t] of [...pending]) {
        if (t.due <= clock) {
          pending.delete(id);
          t.cb();
        }
      }
    },
    connects: 0,
    teardowns: 0,
    logs: [],
  };

  const poller = makeTelegramPoller({
    connect: async () => {
      h.connects++;
      if (connect) await connect();
    },
    poll,
    teardown: async () => {
      h.teardowns++;
    },
    now: () => clock,
    timeoutMs: TG_CALL_TIMEOUT_MS,
    log: (m) => h.logs.push(m),
    timers: {
      setTimeout: (cb, ms) => {
        const id = ++seq;
        pending.set(id, { due: clock + ms, cb });
        return id;
      },
      clearTimeout: (handle) => {
        pending.delete(handle as number);
      },
    },
  });
  h.tick = poller.tick;
  return h;
}

/**
 * Drive the poller the way the real interval would, for `ms` of wall time.
 *
 * A tick is never awaited to completion, because a hung call outlives its own
 * poll interval by design — that is what the timeout is for.
 */
async function run(h: Harness, ms: number) {
  for (let t = 0; t < ms; t += TG_POLL_MS) {
    void h.tick();
    await flush();
    h.advance(TG_POLL_MS);
    await flush();
  }
}

test("flood waits are recognised from the .seconds field and from the message", () => {
  assert.equal(floodWaitSeconds(Object.assign(new Error("x"), { seconds: 452 })), 452);
  // What the connection handshake actually threw in production.
  assert.equal(
    floodWaitSeconds(new Error("A wait of 452 seconds is required (caused by InvokeWithLayer)")),
    452,
  );
  assert.equal(floodWaitSeconds(new Error("getMessages timed out after 60000ms")), null);
  assert.equal(floodWaitSeconds(null), null);
});

test("backoff doubles from the base and stops at the ceiling", () => {
  assert.equal(nextBackoffMs(0), TG_BACKOFF_BASE_MS);
  assert.equal(nextBackoffMs(TG_BACKOFF_BASE_MS), TG_BACKOFF_BASE_MS * 2);
  assert.equal(nextBackoffMs(TG_BACKOFF_MAX_MS), TG_BACKOFF_MAX_MS);
  assert.equal(nextBackoffMs(TG_BACKOFF_MAX_MS * 2), TG_BACKOFF_MAX_MS);
});

test("a call that never settles does not block the next tick", async () => {
  let started = 0;
  const h = harness(() => {
    started++;
    return hang();
  });

  void h.tick();
  await flush();
  assert.equal(started, 1);

  // Without the timeout this call would still be pending, forever, and the
  // interval behind it would quietly stack more of them.
  h.advance(TG_CALL_TIMEOUT_MS + 1);
  await flush();
  assert.equal(h.teardowns, 1, "a call that never returns must be given up on");

  h.advance(TG_BACKOFF_BASE_MS + 1);
  void h.tick();
  await flush();
  assert.equal(started, 2, "and the loop must carry on afterwards");
});

test("a failure destroys the client, since that is what stops gram.js pinging", async () => {
  const h = harness(async () => {
    throw new Error("connection closed");
  });

  await h.tick();
  await flush();

  assert.equal(h.teardowns, 1, "the client must be destroyed, not left pinging");
});

test("a dead host is not stormed: at most one connect per backoff window", async () => {
  const h = harness(async () => {
    throw new Error("connection closed");
  });

  // Four hours of a host that never comes back.
  await run(h, 4 * 60 * 60_000);

  // The bug did ~120 connection attempts an hour. Doubling backoff capped at
  // 30 min cannot exceed ~2/hour once it has settled.
  assert.ok(
    h.connects <= 20,
    `four hours of failure should mean a handful of attempts, got ${h.connects}`,
  );
  assert.ok(h.connects >= 3, "it must still keep trying to come back");
});

test("a flood wait is honoured in full, with a margin", async () => {
  let attempts = 0;
  const h = harness(
    async () => {},
    async () => {
      attempts++;
      throw Object.assign(new Error("A wait of 452 seconds is required"), { seconds: 452 });
    },
  );

  await h.tick();
  await flush();
  assert.equal(attempts, 1);

  // Coming back before the wait lapses is what renewed the penalty forever.
  await run(h, 452_000 + TG_FLOOD_MARGIN_MS - TG_POLL_MS);
  assert.equal(attempts, 1, "must not touch Telegram again inside the flood window");

  h.advance(TG_POLL_MS * 2);
  await h.tick();
  await flush();
  assert.equal(attempts, 2, "should try again once the wait has properly lapsed");
});

test("a flood wait never shortens an already longer backoff", async () => {
  const h = harness(
    async () => {},
    async () => {
      throw Object.assign(new Error("flood"), { seconds: 1 });
    },
  );

  // Grind the backoff up, then a 1-second flood must not undo it.
  await run(h, 3 * 60 * 60_000);
  const settled = h.connects;
  h.advance(TG_POLL_MS);
  await h.tick();
  await flush();
  assert.ok(h.connects - settled <= 1, "a short flood must not reset a long backoff");
});

test("a quiet but healthy group is never torn down", async () => {
  // Zero new messages every time — a quiet night, not a broken client.
  const h = harness(async () => {});

  await run(h, 6 * 60 * 60_000);

  assert.equal(h.teardowns, 0, "an idle but working client must be left alone");
  assert.equal(h.connects, 1, "and must not be reconnected");
});

test("recovering resets the backoff, so the next blip is handled promptly", async () => {
  let healthy = false;
  const h = harness(async () => {
    if (!healthy) throw new Error("connection closed");
  });

  await run(h, 2 * 60 * 60_000);
  assert.ok(h.connects > 1);

  healthy = true;
  await run(h, 60 * 60_000);
  const afterRecovery = h.connects;

  // Fail again: backoff should start from the base, not the ceiling it reached.
  healthy = false;
  await run(h, TG_BACKOFF_BASE_MS + TG_POLL_MS * 3);
  assert.ok(
    h.connects > afterRecovery,
    "a recovered client should retry promptly on the next failure",
  );
});
