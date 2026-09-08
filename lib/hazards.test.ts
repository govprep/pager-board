import test from "node:test";
import assert from "node:assert/strict";
import { areaBbox, inArea, representativePoint, toIso } from "./hazards";

const point = (lng: number, lat: number) => ({ type: "Point", coordinates: [lng, lat] });
const line = (...pairs: [number, number][]) => ({ type: "LineString", coordinates: pairs });

test("a point inside the brigade's area is kept", () => {
  assert.equal(inArea(point(149.23, -35.35)), true); // Queanbeyan
  assert.equal(inArea(point(149.72, -34.75)), true); // Goulburn
});

test("a Sydney hazard is clipped out", () => {
  assert.equal(inArea(point(151.21, -33.87)), false);
});

test("a closure running into the area is kept even though it starts outside", () => {
  // Hume Hwy heading south-west: starts near Sydney, ends near Goulburn.
  assert.equal(inArea(line([150.9, -34.05], [150.4, -34.4], [149.8, -34.7])), true);
});

test("geometry with no coordinates is not in the area", () => {
  assert.equal(inArea(null), false);
  assert.equal(inArea({ type: "Point" }), false);
  assert.equal(inArea({ type: "Point", coordinates: [] }), false);
});

test("HAZARD_BBOX overrides the default area", () => {
  const before = process.env.HAZARD_BBOX;
  process.env.HAZARD_BBOX = "151.0,-34.0,151.5,-33.7";
  assert.deepEqual(areaBbox(), [151.0, -34.0, 151.5, -33.7]);
  assert.equal(inArea(point(151.21, -33.87)), true);
  if (before === undefined) delete process.env.HAZARD_BBOX;
  else process.env.HAZARD_BBOX = before;
});

test("a malformed HAZARD_BBOX falls back to the default rather than matching nothing", () => {
  const before = process.env.HAZARD_BBOX;
  process.env.HAZARD_BBOX = "not,a,bbox";
  assert.deepEqual(areaBbox(), [148.55, -35.75, 150.35, -34.3]);
  if (before === undefined) delete process.env.HAZARD_BBOX;
  else process.env.HAZARD_BBOX = before;
});

test("a point's representative point is itself", () => {
  assert.deepEqual(representativePoint(point(149.2, -35.3)), { lng: 149.2, lat: -35.3 });
});

test("a line's representative point is its middle, not an off-road centroid", () => {
  const mid = representativePoint(line([149.0, -35.0], [149.5, -35.5], [150.0, -35.0]));
  assert.deepEqual(mid, { lng: 149.5, lat: -35.5 });
});

test("a polygon's nested rings are walked", () => {
  const poly = { type: "Polygon", coordinates: [[[149.0, -35.0], [149.1, -35.0], [149.1, -35.1]]] };
  assert.equal(inArea(poly), true);
  assert.notEqual(representativePoint(poly), null);
});

test("epoch milliseconds, epoch seconds and ISO strings all parse", () => {
  assert.equal(toIso(1757289600000), "2025-09-08T00:00:00.000Z");
  assert.equal(toIso(1757289600), "2025-09-08T00:00:00.000Z");
  assert.equal(toIso("2025-09-08T00:00:00Z"), "2025-09-08T00:00:00.000Z");
});

test("an unreadable timestamp is null, never a plausible now()", () => {
  assert.equal(toIso(null), null);
  assert.equal(toIso(""), null);
  assert.equal(toIso("not a date"), null);
  assert.equal(toIso(NaN), null);
});
