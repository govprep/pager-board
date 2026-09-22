import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { weatherFillOpacity } from "./fire-weather-map-style";

const require = createRequire(import.meta.url);
const { validate } = require("mapbox-gl/dist/style-spec/index.cjs") as {
  validate: (style: unknown) => Array<{ message: string }>;
};

test("weather opacity is accepted by the Mapbox style validator", () => {
  const errors = validate({
    version: 8,
    sources: {
      weather: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
    },
    layers: [{
      id: "weather",
      type: "fill",
      source: "weather",
      paint: { "fill-opacity": weatherFillOpacity(0.24) },
    }],
  });

  assert.deepEqual(errors.map((error) => error.message), []);
});
