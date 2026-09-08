import test from "node:test";
import assert from "node:assert/strict";
import { placeJob, stationSuburb, suburbOf } from "./incident-points";
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

test("an RFS page with an address but no coordinates is placed on its suburb", () => {
  const placed = placeJob(job({ location: "15 GREYLEIGH DR,KIAMA,KIAMA (NSW),2533" }));
  assert.equal(placed.precision, "address");
  // The suburb and its postcode — never the street, which these addresses do
  // not write in a way any geocoder can read.
  assert.equal(placed.precision === "address" ? placed.query : "", "KIAMA, NSW 2533");
});

test("the suburb is the segment in front of the LGA, however many roads precede it", () => {
  assert.deepEqual(
    suburbOf("CESSNOCK RD,DAVID ST,NEATH,CESSNOCK CITY (NSW),2326"),
    { suburb: "NEATH", postcode: "2326" },
  );
  assert.deepEqual(
    suburbOf("AFA0071631,UR-3R WASTE MNGT FACILITY,WALLGROVE RD,EASTERN CREEK,BLACKTOWN CITY (NSW),2766"),
    { suburb: "EASTERN CREEK", postcode: "2766" },
  );
});

test("a truncated coords fragment stuck to the postcode doesn't reach the query", () => {
  assert.deepEqual(
    suburbOf("WALLGROVE RD,EASTERN CREEK,BLACKTOWN CITY (NSW),2766 - [150."),
    { suburb: "EASTERN CREEK", postcode: "2766" },
  );
});

test("an address with no LGA marker is left off the map rather than guessed at", () => {
  // "THE ROCKS" here is out past Bathurst. Handed to a geocoder it comes back
  // as the one in Sydney, 200km away — the failure this rule exists to stop.
  assert.equal(suburbOf("MITCHELL HIGHWAY, BACK SWAMP ROAD, THE ROCKS"), null);
  assert.equal(placeJob(job({ location: "MITCHELL HIGHWAY, BACK SWAMP ROAD, THE ROCKS" })).precision, "none");
});

test("a decode that lost the address is never placed", () => {
  assert.equal(placeJob(job({ location: "INCIDENT CA A&50Y$3#A(i" })).precision, "none");
});

test("a road where the suburb should be is not a suburb", () => {
  assert.equal(suburbOf("SOMEWHERE,MITCHELL HIGHWAY,BATHURST REGIONAL (NSW),2795"), null);
});

test("a page that says nothing about where it is has no placement", () => {
  assert.equal(placeJob(job({ units: ["LHBENWE9"] })).precision, "none");
});

test("the postcode joins the suburb, since it is what tells two of them apart", () => {
  const placed = placeJob(job({ location: "SUTTON RD,SUTTON,YASS VALLEY (NSW),2620" }));
  assert.equal(placed.precision === "address" ? placed.query : "", "SUTTON, NSW 2620");
});
