import test from "node:test";
import assert from "node:assert/strict";
import { toHazard } from "./sources/livetraffic";

const NOW = "2026-09-08T02:00:00.000Z";

const feature = (props: Record<string, unknown> = {}, geometry: unknown = {
  type: "Point",
  coordinates: [149.23, -35.35],
}) => ({ geometry, properties: { id: "1234", ...props } });

test("a crash maps onto a hazard row", () => {
  const h = toHazard(feature({
    headline: "Crash",
    displayName: "Kings Hwy",
    isMajor: true,
    created: 1757289600000,
    lastUpdated: 1757293200000,
    roads: [{ mainStreet: "Kings Hwy", suburb: "BUNGENDORE" }],
    webLinkUrl: "https://livetraffic.com/1234",
  }), "incident", NOW)!;

  assert.equal(h.id, "livetraffic|1234");
  assert.equal(h.source, "livetraffic");
  assert.equal(h.category, "incident");
  assert.equal(h.headline, "Crash");
  assert.equal(h.suburb, "BUNGENDORE");
  assert.equal(h.isMajor, true);
  assert.deepEqual(h.coords, { lng: 149.23, lat: -35.35 });
  assert.equal(h.updatedAt, "2025-09-08T01:00:00.000Z");
  assert.equal(h.endedAt, null);
});

test("a feature with no id is dropped — there is nothing stable to key it on", () => {
  assert.equal(toHazard({ properties: {} }, "incident", NOW), null);
  assert.equal(toHazard({}, "incident", NOW), null);
});

test("advice is joined from whichever fields the category happens to use", () => {
  const crash = toHazard(feature({ adviceA: "Exercise caution", adviceB: "Allow extra time" }), "incident", NOW)!;
  assert.equal(crash.advice, "Exercise caution Allow extra time");

  const works = toHazard(feature({ otherAdvice: "Reduced speed limit" }), "roadwork", NOW)!;
  assert.equal(works.advice, "Reduced speed limit");

  const listed = toHazard(feature({ additionalInfo: ["Lane 1 closed", "Police directing"] }), "incident", NOW)!;
  assert.equal(listed.advice, "Lane 1 closed Police directing");
});

test("a hazard with no advice at all is empty, not undefined", () => {
  assert.equal(toHazard(feature(), "incident", NOW)!.advice, "");
});

test("isEnded carries the closing time through", () => {
  const h = toHazard(feature({ isEnded: true, end: 1757296800000 }), "incident", NOW)!;
  assert.equal(h.endedAt, "2025-09-08T02:00:00.000Z");
});

test("an ended hazard with no end time falls back rather than staying open", () => {
  const h = toHazard(feature({ isEnded: true }), "incident", NOW)!;
  assert.equal(h.endedAt, NOW);
});

test("a headline-less hazard falls back to the road, then to the category", () => {
  assert.equal(toHazard(feature({ displayName: "Hume Hwy" }), "roadwork", NOW)!.headline, "Hume Hwy");
  assert.equal(toHazard(feature(), "roadwork", NOW)!.headline, "roadwork");
});

test("timestamps the feed omitted default to the poll time, not to 1970", () => {
  const h = toHazard(feature(), "incident", NOW)!;
  assert.equal(h.startedAt, NOW);
  assert.equal(h.updatedAt, NOW);
});

test("the untouched feature is kept for a mapping fixed later", () => {
  const f = feature({ headline: "Crash", someFieldWeDidNotMap: "kept" });
  assert.deepEqual(toHazard(f, "incident", NOW)!.raw, f);
});

test("a line closure keeps its geometry and gets a point off the middle of it", () => {
  const h = toHazard(
    feature({}, { type: "LineString", coordinates: [[149.0, -35.0], [149.5, -35.2], [150.0, -35.4]] }),
    "roadwork",
    NOW,
  )!;
  assert.deepEqual(h.coords, { lng: 149.5, lat: -35.2 });
  assert.equal((h.geometry as { type: string }).type, "LineString");
});
