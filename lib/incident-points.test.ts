import test from "node:test";
import assert from "node:assert/strict";
import { addressQuery, placeJob, stationSuburb } from "./incident-points";
import { frnswStationName } from "./frnsw-stations";

const job = (over: Partial<Parameters<typeof placeJob>[0]> = {}) => ({
  coords: null,
  location: "",
  units: [],
  raw: "",
  ...over,
});

test("a page with coordinates is placed exactly on them", () => {
  const placed = placeJob(job({ coords: { lng: 149.25, lat: -35.15 }, location: "10 NORTH ST,SUTTON" }));
  assert.equal(placed.precision, "exact");
  assert.deepEqual(placed.precision === "exact" ? placed.coords : null, { lng: 149.25, lat: -35.15 });
});

test("a FRNSW page is placed on its station's suburb", () => {
  const placed = placeJob(job({
    units: ["428 QUEANBEYAN"],
    raw: "FRINC TYPE: AFA TURNOUT: 428 INC: 120047-14062026",
  }));
  assert.equal(placed.precision, "station");
  assert.equal(placed.precision === "station" ? placed.label : "", "QUEANBEYAN");
  assert.equal(placed.precision === "station" ? placed.query : "", "QUEANBEYAN, NSW");
});

test("a FRNSW page whose units were never expanded falls back to the turnout", () => {
  assert.equal(
    stationSuburb(job({ units: ["251"], raw: "FRINC TYPE: HOUSE FIRE TURNOUT: 251 INC: 155168-09082026" })),
    "CARDIFF",
  );
});

// The station list is the source of truth for the name, so this asserts against
// it rather than hard-coding a second copy.
test("the dash layout FRNSW pages arrive in resolves too", () => {
  assert.equal(
    stationSuburb(job({ units: [], raw: "FRINC: MEDICAL ACCESS EMERGENCY – 234 – INC: 156043" })),
    frnswStationName("234"),
  );
});

test("an RFS page with an address but no coordinates is looked up as written", () => {
  const placed = placeJob(job({ location: "15 GREYLEIGH DR,KIAMA,KIAMA (NSW),2533" }));
  assert.equal(placed.precision, "address");
  assert.equal(placed.precision === "address" ? placed.query : "", "15 GREYLEIGH DR, KIAMA, KIAMA, 2533");
});

test("a page that says nothing about where it is has no placement", () => {
  assert.equal(placeJob(job({ units: ["LHBENWE9"] })).precision, "none");
});

test("the state parenthetical is dropped from an address lookup", () => {
  assert.equal(addressQuery("SUTTON RD,SUTTON,YASS VALLEY (NSW),2620"), "SUTTON RD, SUTTON, YASS VALLEY, 2620");
});
