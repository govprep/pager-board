// A station that names no fuels must still produce a usable row.
//
// Its own file rather than another case in fbi.test.ts because getStations
// holds a module-level cache: the first successful lookup in a process serves
// every later one for CACHE_MS, so a second test that needs a *different* set of
// stations can never reach its own stub. node --test runs each file in its own
// process, which is the cheapest way to get a cold cache.
//
// This is the shape every row BOM sent before we started reading the fuel
// fields, and the shape any station whose fuel metadata is incomplete still
// sends — the numbers must survive it, since they are the load-bearing part.

import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { attachFireWeather } from "./fbi";

const emptyDb = {
  from() {
    return this;
  },
  select() {
    return this;
  },
  in() {
    return this;
  },
  not() {
    return Promise.resolve({ data: [], error: null });
  },
} as unknown as SupabaseClient;

test("a station that names no fuels still yields a usable row", async () => {
  process.env.BOM_USER = "u";
  process.env.BOM_PASS = "p";

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            station_info: { station_name: "BARE AWS", latitude: -33.42, longitude: 151.34 },
            observation_data: {
              primary_fbi: 11,
              secondary_fbi: 4,
              seconds_since_epoch: 1_757_000_000,
            },
          },
        ],
      }),
      { status: 200 },
    )) as never;

  let row;
  try {
    [row] = await attachFireWeather(
      emptyDb,
      [
        {
          id: "26-1-BLGWDN1",
          incident_no: "26-1",
          type: "Bush Fire",
          unit: "BLGWDN1",
          location: "SOMEWHERE RD,WYONG",
          coords: { lat: -33.28, lng: 151.42 },
        },
      ],
      { force: true },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  const r = row as Record<string, unknown>;
  const obs = r.fbi_observation as Record<string, unknown>;
  assert.equal(r.primary_fbi, 11);
  assert.equal(r.secondary_fbi, 4);
  assert.equal(r.fbi_station, "BARE AWS");
  // Absent, not undefined — the keys must exist so the batch's rows keep a
  // uniform shape for the upsert.
  assert.equal(obs.primaryFuelModel, null);
  assert.equal(obs.primaryFuelName, null);
  assert.equal(obs.secondaryFuelModel, null);
  assert.equal(obs.secondaryFuelName, null);
});
