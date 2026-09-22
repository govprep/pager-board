import assert from "node:assert/strict";
import test from "node:test";
import type { FireWeatherCoverage } from "./fire-weather-coverage";
import type { CurrentFireWeatherStation } from "./fire-weather-observations";
import { demoFireWeather, demoIncidents } from "./map-demo";

function station(id: string, lat: number): CurrentFireWeatherStation {
  return {
    id,
    name: id,
    description: null,
    lat,
    lng: 150,
    observedAt: "2026-01-01T00:00:00.000Z",
    tempC: 20,
    humidityPct: 40,
    windDir: "N",
    windSpdKmh: 10,
    windGustKmh: 20,
    primary: { slot: "primary", model: null, name: null, code: null, fbi: 1, fdr: 0 },
    secondary: { slot: "secondary", model: null, name: null, code: null, fbi: 2, fdr: 0 },
    maxFbi: 2,
    maxFdr: 0,
    maxFuel: "secondary",
    olderThan30Min: true,
    incomplete: true,
  };
}

test("demo weather makes central NSW high and northern NSW extreme", () => {
  const stations = [station("south", -35.5), station("central", -33), station("north", -30)];
  const coverage = {
    type: "FeatureCollection",
    features: [],
  } satisfies FireWeatherCoverage;
  const result = demoFireWeather(stations, coverage, Date.parse("2026-09-22T00:00:00Z"));

  assert.equal(result.stations[0].maxFdr, 0);
  assert.equal(result.stations[1].maxFdr, 2);
  assert.equal(result.stations[2].maxFdr, 3);
  assert.equal(result.stations[2].olderThan30Min, false);
  assert.equal(result.stations[2].observedAt, "2026-09-22T00:00:00.000Z");
});

test("demo jobs are recent, located and explicitly synthetic", () => {
  const now = Date.parse("2026-09-22T00:00:00Z");
  const incidents = demoIncidents(now);

  assert.equal(incidents.length, 12);
  assert.ok(incidents.every((incident) => incident.coords != null));
  assert.ok(incidents.every((incident) => incident.fields.demo === "true"));
  assert.ok(incidents.every((incident) => now - Date.parse(incident.receivedAt) < 60 * 60 * 1000));
});
