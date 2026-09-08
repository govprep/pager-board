// Tests for broadcast() — the statewide, area-agnostic push used by the daily
// fire danger summary. Unlike incident pushes it ignores area prefs and goes to
// every enrolled device, but it must still honour the same guards: skip revoked
// devices/members, and prune endpoints the push service has retired.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import webpush from "web-push";

// configure() reads these lazily on the first send, so set them before import.
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;

import { broadcast } from "./push";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, any>;

function captureSends() {
  const sent: Array<{ endpoint: string; title: string; body: string; tag: string }> = [];
  let failEndpoint: string | null = null;
  (webpush as any).sendNotification = async (sub: any, payload: string) => {
    if (sub.endpoint === failEndpoint) throw { statusCode: 410 };
    const d = JSON.parse(payload);
    sent.push({ endpoint: sub.endpoint, title: d.title, body: d.body, tag: d.tag });
    return { statusCode: 201 };
  };
  return { sent, fail: (ep: string) => (failEndpoint = ep) };
}

// A live device with a valid subscription: a real push host, a real VAPID
// public key (65 bytes, 0x04-prefixed) and a 16-byte auth secret — the shapes
// isPushEndpoint/isPushKey demand.
function device(endpoint: string, overrides: Row = {}): Row {
  return {
    endpoint,
    p256dh: keys.publicKey,
    auth: Buffer.alloc(16).toString("base64url"),
    fire_digest: true,
    member_devices: { revoked_at: null, members: { revoked_at: null } },
    ...overrides,
  };
}

// Minimal PostgREST double: select over the seeded rows (honouring the inner
// join on member_devices/members and .is() null filters), and delete().in().
function fakeDb(rows: Row[]): SupabaseClient {
  const q = {
    _filters: [] as Array<(r: Row) => boolean>,
    from() {
      this._filters = [];
      return this;
    },
    select(cols?: string) {
      if (cols?.includes("member_devices!inner")) {
        this._filters.push((r) => r.member_devices != null && r.member_devices.members != null);
      }
      return this;
    },
    is(col: string, val: any) {
      this._filters.push((r) => (col.split(".").reduce((v: any, k) => v?.[k], r) ?? null) === val);
      return this;
    },
    eq(col: string, val: any) {
      this._filters.push((r) => r[col] === val);
      return this;
    },
    delete() {
      this._op = "delete";
      return this;
    },
    in(col: string, vals: any[]) {
      const set = new Set(vals);
      if (this._op === "delete") {
        for (let i = rows.length - 1; i >= 0; i--) if (set.has(rows[i][col])) rows.splice(i, 1);
        this._op = undefined;
        return Promise.resolve({ data: null, error: null });
      }
      this._filters.push((r) => set.has(r[col]));
      return this;
    },
    _op: undefined as string | undefined,
    then(onOk: any, onErr: any) {
      const out = rows.filter((r) => this._filters.every((f) => f(r))).map((r) => ({ ...r }));
      return Promise.resolve({ data: out, error: null }).then(onOk, onErr);
    },
  };
  return q as unknown as SupabaseClient;
}

test("broadcast pushes the note to every enrolled device", async () => {
  const cap = captureSends();
  const rows = [device("https://fcm.googleapis.com/a"), device("https://fcm.googleapis.com/b")];
  const n = await broadcast(fakeDb(rows), {
    title: "🔥 PM ratings are in.",
    body: "HIGH about the Northern Slopes tomorrow.",
    tag: "fire-ratings",
  });

  assert.equal(n, 2);
  assert.deepEqual(cap.sent.map((s) => s.endpoint).sort(), ["https://fcm.googleapis.com/a", "https://fcm.googleapis.com/b"]);
  assert.equal(cap.sent[0].title, "🔥 PM ratings are in.");
  assert.equal(cap.sent[0].tag, "fire-ratings");
});

test("broadcast only reaches devices opted into the digest", async () => {
  const cap = captureSends();
  const rows = [
    device("https://fcm.googleapis.com/opted-in"),
    device("https://fcm.googleapis.com/opted-out", { fire_digest: false }),
  ];
  const n = await broadcast(fakeDb(rows), { title: "t", body: "b", tag: "fire-ratings" });

  assert.equal(n, 1);
  assert.deepEqual(cap.sent.map((s) => s.endpoint), ["https://fcm.googleapis.com/opted-in"]);
});

test("broadcast skips revoked devices and revoked members", async () => {
  const cap = captureSends();
  const rows = [
    device("https://fcm.googleapis.com/live"),
    device("https://fcm.googleapis.com/revoked-device", {
      member_devices: { revoked_at: "2026-01-01", members: { revoked_at: null } },
    }),
    device("https://fcm.googleapis.com/revoked-member", {
      member_devices: { revoked_at: null, members: { revoked_at: "2026-01-01" } },
    }),
  ];
  const n = await broadcast(fakeDb(rows), { title: "t", body: "b", tag: "fire-ratings" });

  assert.equal(n, 1);
  assert.deepEqual(cap.sent.map((s) => s.endpoint), ["https://fcm.googleapis.com/live"]);
});

test("broadcast prunes endpoints the push service has retired", async () => {
  const cap = captureSends();
  cap.fail("https://fcm.googleapis.com/gone");
  const rows = [device("https://fcm.googleapis.com/ok"), device("https://fcm.googleapis.com/gone")];
  const n = await broadcast(fakeDb(rows), { title: "t", body: "b", tag: "fire-ratings" });

  assert.equal(n, 1); // one live send, the 410 pruned
  assert.deepEqual(
    rows.map((r) => r.endpoint),
    ["https://fcm.googleapis.com/ok"],
    "the retired endpoint should be deleted",
  );
});
