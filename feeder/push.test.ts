// Regression tests for the push fan-out's de-duplication.
//
// Run: npm test
//
// These drive feeder/push.ts against an in-memory stand-in for the Supabase
// client — just the query shapes pushPending actually issues — so the ordering
// between two concurrent runs is deterministic rather than a matter of luck.

import test from "node:test";
import assert from "node:assert/strict";
import webpush from "web-push";

// VAPID keys must exist before pushPending's lazy configure() runs, and must be
// real ones: setVapidDetails validates them.
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
process.env.VAPID_SUBJECT = "mailto:test@example.com";

import { pushPending } from "./push";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Records what would have gone to the push services, and holds each send open
// long enough that a second concurrent run reaches its own read first — the
// window the real push services' round-trip opens.
function captureSends(sendMs = 20) {
  const sent: Array<{ endpoint: string; title: string; body: string }> = [];
  (webpush as any).sendNotification = async (sub: any, payload: string) => {
    const data = JSON.parse(payload);
    sent.push({ endpoint: sub.endpoint, title: data.title, body: data.body });
    await delay(sendMs);
    return { statusCode: 201 };
  };
  return sent;
}

/** The handful of PostgREST verbs pushPending uses, over plain arrays. */
class FakeQuery implements PromiseLike<any> {
  private filters: Array<(r: Row) => boolean> = [];
  private sort: { col: string; asc: boolean } | null = null;

  constructor(
    private tables: Tables,
    private table: string,
    private op: "select" | "delete" | "update" | "upsert",
    private payload?: any,
  ) {}

  private get rows(): Row[] {
    return (this.tables[this.table] ??= []);
  }

  in(col: string, vals: any[]) {
    const set = new Set(vals);
    this.filters.push((r) => set.has(r[col]));
    return this;
  }
  eq(col: string, val: any) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  is(col: string, val: any) {
    this.filters.push((r) => (r[col] ?? null) === val);
    return this;
  }
  // Only ever called as .not(col, "is", null).
  not(col: string, _op: string, _val: any) {
    this.filters.push((r) => (r[col] ?? null) !== null);
    return this;
  }
  lt(col: string, val: any) {
    this.filters.push((r) => r[col] != null && String(r[col]) < String(val));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.sort = { col, asc: opts?.ascending !== false };
    return this;
  }
  select(_cols?: string) {
    return this;
  }

  then<A, B>(onOk?: any, onErr?: any): PromiseLike<A | B> {
    return this.run().then(onOk, onErr);
  }

  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every((f) => f(r)));
  }

  private async run() {
    await Promise.resolve(); // every call is a real await point
    switch (this.op) {
      case "select": {
        const out = this.matched().map((r) => ({ ...r }));
        if (this.sort) {
          const { col, asc } = this.sort;
          out.sort((a, b) =>
            String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : String(a[col]) > String(b[col]) ? (asc ? 1 : -1) : 0,
          );
        }
        return { data: out, error: null };
      }
      case "delete": {
        const doomed = new Set(this.matched());
        this.tables[this.table] = this.rows.filter((r) => !doomed.has(r));
        return { data: null, error: null };
      }
      case "update": {
        for (const r of this.matched()) Object.assign(r, this.payload);
        return { data: null, error: null };
      }
      case "upsert": {
        for (const incoming of this.payload as Row[]) {
          const hit = this.rows.find(
            (r) => r.incident_no === incoming.incident_no && r.endpoint === incoming.endpoint,
          );
          if (hit) Object.assign(hit, incoming);
          else this.rows.push({ ...incoming });
        }
        return { data: null, error: null };
      }
    }
  }
}

function fakeDb(tables: Tables): SupabaseClient {
  return {
    from(table: string) {
      return {
        select: (_c?: string) => new FakeQuery(tables, table, "select"),
        delete: () => new FakeQuery(tables, table, "delete"),
        update: (payload: any) => new FakeQuery(tables, table, "update", payload),
        upsert: (payload: any, _o?: any) => new FakeQuery(tables, table, "upsert", payload),
      };
    },
  } as unknown as SupabaseClient;
}

// Two appliance pages of one brand-new job, as two separate rows — which is how
// the board stores them (id = incident number + unit).
function twoPageIncident(): Tables {
  const now = new Date().toISOString();
  const page = (unit: string) => ({
    id: `26-1-${unit}`,
    incident_no: "26-1",
    type: "STRUCT",
    unit,
    location: "RINGWOOD RD,WONGA PARK",
    raw: `STRUCT RINGWOOD RD,WONGA PARK ${unit} 26-1`,
    received_at: now,
    fields: {},
    pushed_at: null,
  });
  return {
    incidents: [page("CMEASCR1"), page("CMLLAND1")],
    push_subscriptions: [
      { endpoint: "https://push.example/phone-a", p256dh: "p", auth: "a", alert_all: true, lgas: [], stations: [] },
    ],
    incident_subscriptions: [],
  };
}

// A bush-fire job carrying the figure attachFireWeather stamps onto it.
// primary/secondary are deliberately the "wrong" way round — the higher rating
// is the *secondary* one — so a notification that simply read primary_fbi would
// quote 7 and fail this rather than passing by luck.
function fireIncident(): Tables {
  const now = new Date().toISOString();
  return {
    incidents: [
      {
        id: "26-2-BLGWDN1",
        incident_no: "26-2",
        type: "Bush Fire",
        unit: "BLGWDN1",
        location: "SOMEWHERE RD,WYONG",
        raw: "Bush Fire SOMEWHERE RD,WYONG BLGWDN1 26-2",
        received_at: now,
        fields: {},
        pushed_at: null,
        primary_fbi: 7,
        secondary_fbi: 23,
        fbi_station: "GOSFORD AWS",
        fbi_distance_km: 12.4,
        fbi_observed_at: now,
        fbi_observation: {},
      },
    ],
    push_subscriptions: [
      { endpoint: "https://push.example/phone-a", p256dh: "p", auth: "a", alert_all: true, lgas: [], stations: [] },
    ],
    incident_subscriptions: [],
  };
}

test("a fire-weather job's alert carries the highest nearby FBI", async () => {
  const tables = fireIncident();
  const sent = captureSends(0);

  await pushPending(fakeDb(tables), ["26-2-BLGWDN1"]);

  const alert = sent.find((s) => s.title.startsWith("🚨"));
  assert.ok(alert, `expected a new-incident alert, got ${JSON.stringify(sent)}`);
  assert.match(alert.body, /HIGHEST NEARBY FBI 23/);
  // The address is what the body is for; the FBI rides along after it.
  assert.match(alert.body, /^SOMEWHERE RD,WYONG · /);
});

test("a job with no fire weather says nothing about FBI", async () => {
  const tables = twoPageIncident(); // STRUCT, no fbi columns at all
  const sent = captureSends(0);

  await pushPending(fakeDb(tables), ["26-1-CMEASCR1"]);

  const alert = sent.find((s) => s.title.startsWith("🚨"));
  assert.ok(alert);
  assert.doesNotMatch(alert.body, /FBI/);
  assert.equal(alert.body, "RINGWOOD RD,WONGA PARK");
});

test("two pages of one new incident, pushed concurrently, alert the phone once", async () => {
  const tables = twoPageIncident();
  const db = fakeDb(tables);
  const sent = captureSends();

  // Each source upserts its own page and immediately fans out — the two runs
  // overlap because nothing serialises them.
  await Promise.all([pushPending(db, ["26-1-CMEASCR1"]), pushPending(db, ["26-1-CMLLAND1"])]);

  const newIncidentAlerts = sent.filter((s) => s.title.startsWith("🚨"));
  assert.equal(
    newIncidentAlerts.length,
    1,
    `expected one new-incident alert, got ${newIncidentAlerts.length}: ${JSON.stringify(sent, null, 2)}`,
  );

  // Both pages must still be accounted for, so neither re-queues next batch.
  assert.ok(
    tables.incidents.every((r) => r.pushed_at != null),
    "every page should be stamped pushed",
  );
});

test("a second page arriving after the first has been pushed is not a new-incident alert", async () => {
  const tables = twoPageIncident();
  const db = fakeDb(tables);
  const sent = captureSends(0);

  await pushPending(db, ["26-1-CMEASCR1"]);
  await pushPending(db, ["26-1-CMLLAND1"]);

  assert.equal(sent.filter((s) => s.title.startsWith("🚨")).length, 1);
});
