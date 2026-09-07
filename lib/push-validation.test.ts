import test from "node:test";
import assert from "node:assert/strict";
import { isIncidentNumber, isPushEndpoint, isPushKey } from "./push-validation";

test("push endpoints allow established HTTPS services only", () => {
  for (const host of ["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "wns2-db5p.notify.windows.com"]) {
    assert.equal(isPushEndpoint(`https://${host}/subscription/abc`), true, host);
  }
  for (const endpoint of [null, {}, 42, "http://fcm.googleapis.com/a", "https://localhost/a", "https://127.0.0.1/a", "https://[::1]/a", "https://fcm.googleapis.com.evil.test/a", "https://evil.notify.windows.com.evil.test/a", "https://user:secret@fcm.googleapis.com/a", "https://fcm.googleapis.com:8443/a", "https://fcm.googleapis.com:443/a", "https://fcm.googlea\npis.com/a", "https://fcm.googleapis.com/a#fragment", " https://fcm.googleapis.com/a"]) {
    assert.equal(isPushEndpoint(endpoint), false, String(endpoint));
  }
});

test("push keys validate decoded length, canonical base64url and EC prefix", () => {
  const publicKey = Buffer.alloc(65, 1);
  publicKey[0] = 4;
  assert.equal(isPushKey(publicKey.toString("base64url"), 65), true);
  assert.equal(isPushKey(Buffer.alloc(16).toString("base64url"), 16), true);
  for (const value of [null, {}, "", "a", "a".repeat(1000), Buffer.alloc(64).toString("base64url"), Buffer.alloc(65).toString("base64url")]) {
    assert.equal(isPushKey(value, 65), false);
  }
  assert.equal(isPushKey("AAAAAAAAAAAAAAAAAAAAAB", 16), false, "noncanonical trailing bits");
});

test("incident numbers reject malformed types and control characters", () => {
  assert.equal(isIncidentNumber("155212-09082026"), true);
  for (const value of [null, {}, "", " x", "x\n", "x\u0000", "a".repeat(129)]) {
    assert.equal(isIncidentNumber(value), false);
  }
});
