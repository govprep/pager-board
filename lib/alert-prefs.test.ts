// Tests for the fireDigest preference — the per-device opt-in for the daily BOM
// fire danger summary. It's a true opt-in: absent or non-true means off, so a
// device only receives the digest after explicitly turning it on.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePrefs, DEFAULT_PREFS } from "./alert-prefs";

test("fireDigest defaults off", () => {
  assert.equal(DEFAULT_PREFS.fireDigest, false);
});

test("sanitizePrefs treats a missing fireDigest as off", () => {
  assert.equal(sanitizePrefs({ alertAll: true, lgas: [], stations: [] }).fireDigest, false);
});

test("sanitizePrefs turns fireDigest on only for an explicit true", () => {
  assert.equal(sanitizePrefs({ fireDigest: true }).fireDigest, true);
  // Anything short of a real boolean true stays off — no truthy coercion.
  assert.equal(sanitizePrefs({ fireDigest: "yes" }).fireDigest, false);
  assert.equal(sanitizePrefs({ fireDigest: 1 }).fireDigest, false);
});
