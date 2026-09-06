// Regression tests for the live sockets' silence watchdog.
//
// Run: npm test
//
// The bug these exist for: a PagerMon Socket.IO connection that stops
// delivering is indistinguishable, at the transport level, from a quiet night.
// The socket stays open, ping/pong keeps passing, no `disconnect` ever fires —
// and nothing arrives again. Measured over a three-day sample, pocsag.net was
// silent for 84% of the window with individual gaps of six hours, while
// pager-feed.net on the identical code path was quiet only 26% of the time and
// never for longer than 83 minutes. Reconnection was already on; it never had
// anything to react to, because at the socket's own level nothing was wrong.
//
// So liveness is judged on messages arriving, not on the socket's opinion of
// itself.

import test from "node:test";
import assert from "node:assert/strict";

import { makeSilenceWatchdog, SILENCE_MS } from "./sources/pagermon-live";

const MIN = 60_000;

test("stays quiet while traffic is arriving", () => {
  const wd = makeSilenceWatchdog(SILENCE_MS, 0);
  for (let t = 0; t <= 60 * MIN; t += 5 * MIN) {
    wd.alive(t);
    assert.equal(wd.check(t + MIN), false, `fired at ${t / MIN} min despite traffic`);
  }
});

test("stays quiet up to the threshold, then asks for a reconnect", () => {
  const wd = makeSilenceWatchdog(SILENCE_MS, 0);
  assert.equal(wd.check(SILENCE_MS - 1), false);
  assert.equal(wd.check(SILENCE_MS), true);
});

test("asks only once per silence, not on every tick", () => {
  const wd = makeSilenceWatchdog(SILENCE_MS, 0);
  assert.equal(wd.check(SILENCE_MS), true);
  // A reconnect takes a moment to produce traffic; the watchdog must not fire
  // again on the very next minute, or a dead feed reconnects in a tight loop.
  assert.equal(wd.check(SILENCE_MS + MIN), false);
  assert.equal(wd.check(SILENCE_MS + 5 * MIN), false);
  // But a reconnect that fixed nothing is caught again a full silence later.
  assert.equal(wd.check(2 * SILENCE_MS), true);
});

test("traffic after a reconnect re-arms the full window", () => {
  const wd = makeSilenceWatchdog(SILENCE_MS, 0);
  assert.equal(wd.check(SILENCE_MS), true);
  wd.alive(SILENCE_MS + MIN);
  assert.equal(wd.check(2 * SILENCE_MS), false, "traffic resumed — nothing to do");
  assert.equal(wd.check(SILENCE_MS + MIN + SILENCE_MS), true);
});

test("the window bounds how long we can be dead without noticing", () => {
  // The threshold is set by how long we're willing to be blind, NOT by how
  // quiet a feed may legitimately go: bouncing a healthy-but-idle socket costs
  // one handshake and loses nothing, while missing a dead one cost six hours in
  // the sample. So it's deliberately shorter than pager-feed's longest natural
  // silence (83 min) — those nights simply reconnect a few times.
  assert.ok(SILENCE_MS <= 30 * MIN, `SILENCE_MS is ${SILENCE_MS / MIN} min — too long to be blind`);
  // Long enough not to fire between pages during ordinary traffic.
  assert.ok(SILENCE_MS >= 10 * MIN, `SILENCE_MS is ${SILENCE_MS / MIN} min — will bounce a busy feed`);
});
