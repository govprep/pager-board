import test from "node:test";
import assert from "node:assert/strict";

import {
  makeStoredFireWeatherSnapshot,
  parseStoredFireWeatherSnapshot,
} from "./fire-weather-snapshot";

test("stored snapshots round-trip and reject malformed state", () => {
  const stored = makeStoredFireWeatherSnapshot([], 4, "2026-09-21T03:00:00.000Z");
  assert.deepEqual(parseStoredFireWeatherSnapshot(JSON.parse(JSON.stringify(stored))), stored);
  assert.equal(parseStoredFireWeatherSnapshot({ stations: [], sourceStationCount: 4 }), null);
  assert.equal(parseStoredFireWeatherSnapshot({ fetchedAt: "bad", stations: [], sourceStationCount: 4 }), null);
});
