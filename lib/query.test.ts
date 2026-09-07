import test from "node:test";
import assert from "node:assert/strict";
import { filterLiteral, incidentFilter, keysetFilter, readPagination, validateLines } from "./query";

test("pagination rejects malformed limits and cursor filter injection", () => {
  for (const limit of ["NaN", "Infinity", "0", "-1", "1.5", ""]) {
    assert.throws(() => readPagination(new URLSearchParams({ limit }), "beforeId"));
  }
  assert.throws(() => readPagination(new URLSearchParams({ before: "2026-01-01,raw.neq.x" }), "beforeId"));
  assert.throws(() => readPagination(new URLSearchParams({ beforeId: "some-id" }), "beforeId"));
  assert.equal(readPagination(new URLSearchParams({ limit: "999" }), "beforeId").limit, 500);
});

test("database timestamp precision survives pagination", () => {
  const before = "2026-09-07T01:02:03.123456+00:00";
  const result = readPagination(new URLSearchParams({ before, beforeId: "26-123-UNIT 1" }), "beforeId");
  assert.equal(result.before, before);
  assert.equal(result.key, "26-123-UNIT 1");
});

test("PostgREST literals contain quotes, backslashes and filter punctuation", () => {
  assert.equal(filterLiteral('a"b\\c,d(e)'), '"a\\"b\\\\c,d(e)"');
  const maliciousKey = 'x),raw.neq."secret';
  assert.ok(keysetFilter("2026-09-07T00:00:00Z", "id", maliciousKey).endsWith(`id.lt.${filterLiteral(maliciousKey)})`));
});

test("search and keyset pagination retain both predicates and the ID tiebreaker", () => {
  const filter = incidentFilter("fire", "2026-09-07T00:00:00Z", "26-123-X");
  assert.ok(filter?.startsWith("and(or(incident_no.ilike."));
  assert.ok(filter?.includes('id.lt."26-123-X"'));
  assert.equal(incidentFilter(" "), undefined);
});

test("ingestion rejects non-string entries and excessive message batches", () => {
  for (const input of [[null], [{}], [1], Array(501).fill("line"), ["a".repeat(8193)]]) {
    assert.throws(() => validateLines(input));
  }
  assert.deepEqual(validateLines(["  page  ", " "]), ["page"]);
});
