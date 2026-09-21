import test from "node:test";
import assert from "node:assert/strict";

import { buildFireWeatherCoverage } from "./fire-weather-coverage";
import type { CurrentFireWeatherStation } from "./fire-weather-observations";

function station(
  id: string,
  lng: number,
  lat: number,
  maxFbi: number | null,
  olderThan30Min = false,
): CurrentFireWeatherStation {
  return {
    id,
    name: id,
    description: null,
    lng,
    lat,
    observedAt: "2026-09-21T03:00:00.000Z",
    tempC: 20,
    humidityPct: 40,
    windDir: "NW",
    windSpdKmh: 15,
    windGustKmh: 25,
    primary: { slot: "primary", model: null, name: null, code: null, fbi: maxFbi, fdr: 1 },
    secondary: { slot: "secondary", model: null, name: null, code: null, fbi: null, fdr: null },
    maxFbi,
    maxFdr: maxFbi == null ? null : maxFbi >= 24 ? 2 : maxFbi >= 12 ? 1 : 0,
    maxFuel: maxFbi == null ? null : "primary",
    olderThan30Min,
    incomplete: false,
  };
}

test("coverage creates 20/40/60 km land-clipped bands for current rated stations", () => {
  const coverage = buildFireWeatherCoverage([
    station("canberra", 149.13, -35.28, 18),
    station("bathurst", 149.58, -33.42, 32),
    station("old", 148.6, -34.8, 80, true),
    station("missing", 150.2, -34.4, null),
  ]);

  assert.deepEqual(new Set(coverage.features.map((feature) => feature.properties.id)), new Set(["canberra", "bathurst"]));
  for (const id of ["canberra", "bathurst"]) {
    assert.deepEqual(
      new Set(coverage.features.filter((feature) => feature.properties.id === id).map((feature) => feature.properties.radiusKm)),
      new Set([20, 40, 60]),
    );
  }
});

test("co-located stations use only the higher FBI", () => {
  const coverage = buildFireWeatherCoverage([
    station("lower", 149.13, -35.28, 18),
    station("higher", 149.13, -35.28, 55),
    station("bathurst", 149.58, -33.42, 32),
  ]);

  assert.equal(coverage.features.some((feature) => feature.properties.id === "lower"), false);
  assert.equal(coverage.features.some((feature) => feature.properties.id === "higher"), true);
});
