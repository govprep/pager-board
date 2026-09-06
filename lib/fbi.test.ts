// Regression tests for the Fire Behaviour Index lookup.
//
// Run: npm test
//
// The bug these exist for: with BOM_USER/BOM_PASS unset, fetchStations returned
// an empty list without throwing or logging, getStations cached that as a good
// fetch, and every qualifying job was stamped with a null FBI. Nothing in the
// log said why, so the feature looked identical to a quiet fire season. It ran
// that way from the moment it shipped, because the credentials documented in
// .env.example were never added to .env.local.

import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { attachFireWeather, isFireWeatherType } from "./fbi";

// attachFireWeather's only query is the stored-figure lookup. Nothing is stored
// in these tests, so every job here is one that has never had a figure.
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

/** A real qualifying job: RFS vegetation fire, with coordinates. */
function bushFire() {
  return {
    id: "26-126678-BLGWDN1",
    incident_no: "26-126678",
    type: "Bush Fire",
    unit: "BLGWDN1",
    location: "SOMEWHERE RD,WYONG",
    coords: { lat: -33.28, lng: 151.42 },
  };
}

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  return { lines, restore: () => void (console.warn = realWarn) };
}

test("the type filter keeps fire-weather calls and drops the rest", () => {
  for (const t of ["Bush Fire", "Grass", "SCRUB FIRE", "Smoke report", "Unknown Fire"]) {
    assert.equal(isFireWeatherType(t), true, `${t} should qualify`);
  }
  // The exclude list wins even when a vegetation word appears in passing.
  for (const t of ["AFA", "Structure Fire", "MVA", "Vehicle fire in grass", ""]) {
    assert.equal(isFireWeatherType(t), false, `${t} should not qualify`);
  }
});

test("without BOM credentials a qualifying job is nulled — but says so in the log", async () => {
  delete process.env.BOM_USER;
  delete process.env.BOM_PASS;

  const warn = captureWarnings();
  let row;
  try {
    [row] = await attachFireWeather(emptyDb, [bushFire()]);
  } finally {
    warn.restore();
  }

  const r = row as Record<string, unknown>;
  assert.equal(r.primary_fbi, null);
  assert.equal(r.fbi_station, null);
  assert.equal(r.fbi_computed_at, null);

  // The point of the test: it must not be silent about it.
  assert.equal(warn.lines.length, 1, `expected one warning, got ${JSON.stringify(warn.lines)}`);
  assert.match(warn.lines[0], /BOM_USER\/BOM_PASS not set/);
});

test("a job that fire weather doesn't apply to is nulled without asking BOM", async () => {
  process.env.BOM_USER = "u";
  process.env.BOM_PASS = "p";

  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => assert.fail("BOM must not be called for an ineligible job")) as never;
  try {
    const [alarm] = await attachFireWeather(emptyDb, [{ ...bushFire(), type: "AFA" }]);
    const [noCoords] = await attachFireWeather(emptyDb, [{ ...bushFire(), coords: null }]);
    assert.equal((alarm as Record<string, unknown>).primary_fbi, null);
    assert.equal((noCoords as Record<string, unknown>).primary_fbi, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Runs *after* the unconfigured test above, and depends on it: the old code
// wrote the empty station list from that call into the module cache as though it
// were a good fetch, so this one found a warm, empty cache and produced a null
// FBI even though BOM answered perfectly. That is the second half of the same
// bug — one bad lookup poisoning the next five minutes of good ones — so keep
// these two in this order.
test("the nearest station's reading is what lands on the row", async () => {
  process.env.BOM_USER = "u";
  process.env.BOM_PASS = "p";

  const station = (name: string, lat: number, lng: number, primary: number, secondary: number) => ({
    station_info: {
      station_name: name,
      latitude: lat,
      longitude: lng,
      // Which fuel each rating describes. Deliberately a station whose two
      // fuels differ, since that is the whole reason the modal names them.
      primary_fbm: "Forest",
      primary_fine_fuel_name: "Swamp forests",
      secondary_fbm: "Shrubland",
      secondary_fine_fuel_name: "Short heath",
    },
    observation_data: {
      primary_fbi: primary,
      secondary_fbi: secondary,
      seconds_since_epoch: 1_757_000_000,
      temp: 21.5,
      rh: 40,
      wind_dir: "NW",
      wnd_spd_kmh: 18,
      wnd_gust_spd_kmh: 30,
    },
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          // Far away (Broken Hill-ish) with the alarming numbers, so a lookup
          // that ignored distance would pick this one.
          station("FAR AWAY AWS", -31.95, 141.45, 90, 95),
          station("GOSFORD AWS", -33.42, 151.34, 23, 7),
        ],
      }),
      { status: 200 },
    )) as never;

  let row;
  try {
    [row] = await attachFireWeather(emptyDb, [bushFire()], { force: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  const r = row as Record<string, unknown>;
  assert.equal(r.fbi_station, "GOSFORD AWS");
  assert.equal(r.primary_fbi, 23);
  assert.equal(r.secondary_fbi, 7);
  assert.ok((r.fbi_distance_km as number) < 30, `expected a nearby station, got ${r.fbi_distance_km}km`);
  assert.deepEqual(r.fbi_observation, {
    tempC: 21.5,
    humidityPct: 40,
    windDir: "NW",
    windSpdKmh: 18,
    windGustKmh: 30,
    primaryFuelModel: "Forest",
    primaryFuelName: "Swamp forests",
    secondaryFuelModel: "Shrubland",
    secondaryFuelName: "Short heath",
  });
});

