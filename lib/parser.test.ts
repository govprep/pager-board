// Regression tests for the pager line parser.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";

import { parsePagerMessage } from "./parser";

// Some feeds log the page with the time they heard it in front of it. Left on,
// the positional reader takes "06" for the alert level and "September" for the
// station, so every prefixed page reached the board as a resource named
// September — and under an id ("26-125953-September") no other source shares.
const PREFIXED =
  "06 September 2026 17:12:11 CVDO - 26-125953 - Grass - FIRECALL - " +
  "JACKYS CREEK RD,OLD GLEN INNES RD,CHAMBIGNE,CLARENCE VALLEY (NSW),2460 - " +
  "[152.786347254,-29.729693074]";

test("a page logged with a date in front of it keeps its own resource", () => {
  const inc = parsePagerMessage(PREFIXED, "2026-09-06T07:12:11.000Z");
  assert.equal(inc?.unit, "CVDO");
  assert.equal(inc?.incidentNo, "26-125953");
  assert.equal(inc?.type, "Grass");
});

test("the date prefix is not read as part of the address", () => {
  const inc = parsePagerMessage(PREFIXED, "2026-09-06T07:12:11.000Z");
  assert.equal(
    inc?.location,
    "JACKYS CREEK RD,OLD GLEN INNES RD,CHAMBIGNE,CLARENCE VALLEY (NSW),2460",
  );
  assert.deepEqual(inc?.coords, { lng: 152.786347254, lat: -29.729693074 });
});

test("a prefixed page lands on the same row as the same page without one", () => {
  const bare = PREFIXED.replace(/^\d{1,2}\s+\w+\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+/, "");
  assert.equal(
    parsePagerMessage(PREFIXED, "2026-09-06T07:12:11.000Z")?.id,
    parsePagerMessage(bare, "2026-09-06T07:12:11.000Z")?.id,
  );
});

test("the time the page states is used when the source gave us none", () => {
  const inc = parsePagerMessage(PREFIXED);
  assert.equal(inc?.receivedAt, new Date("September 06 2026 17:12:11").toISOString());
});

test("a time the source supplied wins over the one in the line", () => {
  const inc = parsePagerMessage(PREFIXED, "2026-01-01T00:00:00.000Z");
  assert.equal(inc?.receivedAt, "2026-01-01T00:00:00.000Z");
});

// The positional header itself starts with a digit ("2 STSUTTO - …"), so the
// prefix test has to be anchored tightly enough not to eat it.
test("an ordinary positional page is untouched", () => {
  const inc = parsePagerMessage(
    "2 STSUTTO - 26-118273 - Chimney fire - FIRECALL - 10 NORTH ST,SUTTON,YASS VALLEY (NSW),2620 - [149.255855,-35.158894]",
    "2026-09-06T07:12:11.000Z",
  );
  assert.equal(inc?.unit, "STSUTTO");
  assert.equal(inc?.receivedAt, "2026-09-06T07:12:11.000Z");
});

// Real board row: the decode corrupted the month word. The time is then
// unreadable, but the page behind it is intact and still belongs to THWISFE1.
test("a prefix whose month is mis-decoded still isn't read as the resource", () => {
  const inc = parsePagerMessage(
    "05 Setember 2026 17:32:22 THWISFE1 - 26-126545 - BBQ fire/Bonfire/Yard fire - FIRECALL - MILL CREEK CAMPING GROUND,GUNDERMAN,CENTRAL COAST (NSW),2775 - 151.043465,-33.401091",
    "2026-09-05T07:32:46.000Z",
  );
  assert.equal(inc?.unit, "THWISFE1");
  assert.equal(inc?.type, "BBQ fire/Bonfire/Yard fire");
});

test("an unreadable prefix time falls back rather than inventing one", () => {
  const inc = parsePagerMessage(
    "05 Setember 2026 17:32:22 THWISFE1 - 26-126545 - BBQ fire - FIRECALL - GUNDERMAN,CENTRAL COAST (NSW),2775",
    "2026-09-05T07:32:46.000Z",
  );
  assert.equal(inc?.receivedAt, "2026-09-05T07:32:46.000Z");
});

// Real board rows: the decode corrupted the prefix's own numbers, so the strict
// shape above (a clean hh:mm:ss) doesn't match — but the day-month-year opening
// is still unmistakable, and the page behind it is intact.
test("a prefix whose time ran into the year is still not the resource", () => {
  const inc = parsePagerMessage(
    "03 August 202641;:33:55 CMNAREL1 - 26-122680 - Structure/building/house fire - STRUCTURE FIRE - 85 BAMBURGH RD,WEROMBI,WOLLONDILLY (NSW),2570 - [150.59354,-33.9879]",
    "2026-08-02T23:34:31.000Z",
  );
  assert.equal(inc?.unit, "CMNAREL1");
  assert.equal(inc?.type, "Structure/building/house fire");
  assert.equal(inc?.location, "85 BAMBURGH RD,WEROMBI,WOLLONDILLY (NSW),2570");
  assert.deepEqual(inc?.coords, { lng: 150.59354, lat: -33.9879 });
});

// The dangerous neighbour of the rule above: a positional header is "{level}
// {station}", and a station's name can begin with a month ("2 MAYFIELD"). Only
// a year after the word makes it a date, so that is what the rule requires.
test("a station whose name starts with a month is left alone", () => {
  const inc = parsePagerMessage(
    "2 MAYFIELD - 26-123456 - Chimney fire - FIRECALL - 10 NORTH ST,SUTTON,YASS VALLEY (NSW),2620",
    "2026-09-06T07:12:11.000Z",
  );
  assert.equal(inc?.unit, "MAYFIELD");
  assert.equal(inc?.incidentNo, "26-123456");
});

test("a mangled prefix carries no time, so the source's stands", () => {
  const inc = parsePagerMessage(
    "03 August 202641;:33:55 CMNAREL1 - 26-122680 - Structure/building/house fire - STRUCTURE FIRE - 85 BAMBURGH RD,WEROMBI",
    "2026-08-02T23:34:31.000Z",
  );
  assert.equal(inc?.receivedAt, "2026-08-02T23:34:31.000Z");
});
