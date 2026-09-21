import test from "node:test";
import assert from "node:assert/strict";

import {
  fdrForFbi,
  parseFireWeatherObservations,
  parseFireWeatherObservationSnapshot,
} from "./fire-weather-observations";

test("AFDRS thresholds classify FBI values at every boundary", () => {
  assert.deepEqual(
    [-1, 0, 11, 12, 23, 24, 49, 50, 99, 100].map(fdrForFbi),
    [null, 0, 0, 1, 1, 2, 2, 3, 3, 4],
  );
});

test("station display maximum uses only the higher primary/secondary fuel", () => {
  const [station] = parseFireWeatherObservations({
    data: [{
      station_info: {
        bom_id: 123,
        station_name: "TEST AWS",
        description: "Test",
        latitude: -33.5,
        longitude: 150.5,
        primary_fbm: "Forest",
        primary_fine_fuel_name: "Dry forest",
        primary_fine_fuel_type_code: 1001,
        secondary_fbm: "Grassland",
        secondary_fine_fuel_name: "Pasture",
        secondary_fine_fuel_type_code: 2001,
        incomplete_obs: true,
      },
      observation_data: {
        seconds_since_epoch: 1_800_000_000,
        primary_fbi: 18,
        primary_fdr: 1,
        secondary_fbi: 28,
        secondary_fdr: 2,
        // Higher, but explicitly outside the requested type 1/type 2 maximum.
        fuel_at_point_fbi: 90,
        temp: 31.2,
        rh: 19,
        wind_dir: "NW",
        wnd_spd_kmh: 22,
        wnd_gust_spd_kmh: 35,
      },
    }],
  });

  assert.equal(station.maxFbi, 28);
  assert.equal(station.maxFdr, 2);
  assert.equal(station.maxFuel, "secondary");
  assert.equal(station.primary.name, "Dry forest");
  assert.equal(station.secondary.name, "Pasture");
  assert.equal(station.incomplete, true);
});

test("a located station without FBI remains visible as an unavailable station", () => {
  const [station] = parseFireWeatherObservations({
    data: [{
      station_info: { station_name: "NO FBI", latitude: -32, longitude: 148 },
      observation_data: { seconds_since_epoch: 1_800_000_000, temp: 20 },
    }],
  });

  assert.equal(station.maxFbi, null);
  assert.equal(station.maxFdr, null);
  assert.equal(station.maxFuel, null);
  assert.equal(station.tempC, 20);
});

test("the snapshot reports feed stations that cannot be put on a map", () => {
  const snapshot = parseFireWeatherObservationSnapshot({
    data: [
      { station_info: { station_name: "LOCATED", latitude: -32, longitude: 148 }, observation_data: { seconds_since_epoch: 1_800_000_000 } },
      { station_info: { station_name: "PORTABLE WITHOUT COORDS" }, observation_data: { seconds_since_epoch: 1_800_000_000 } },
    ],
  });
  assert.equal(snapshot.sourceStationCount, 2);
  assert.equal(snapshot.stations.length, 1);
});
