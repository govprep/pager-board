import test from "node:test";
import assert from "node:assert/strict";

import { passesBoardFilter } from "./filter";

test("the known malformed 26-131793 page never reaches the board", () => {
  assert.equal(
    passesBoardFilter(
      "THDO - 26-131793 - WIRES DOWN/ARCING - FIRECALL - " +
      "COMMERCIAL RD,BOUNDARY RD,VINEYARD,HAWKESBURY CITY (NSW),2765",
    ),
    false,
  );
});

test("nearby incident numbers remain eligible", () => {
  assert.equal(
    passesBoardFilter(
      "THDO - 26-131794 - WIRES DOWN/ARCING - FIRECALL - " +
      "COMMERCIAL RD,BOUNDARY RD,VINEYARD,HAWKESBURY CITY (NSW),2765",
    ),
    true,
  );
});
