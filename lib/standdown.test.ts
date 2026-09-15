import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyStandDowns, parseStandDown } from "./standdown";

test("stand-down batches share a lookup while retaining per-resource cancellation", async () => {
  const lookups: string[][] = [];
  const updates: string[][] = [];
  const rows = [
    { id: "a", incident_no: "26-123456", unit: "LHBENWE9" },
    { id: "b", incident_no: "26-123456", unit: "LHOTHER1" },
    { id: "c", incident_no: "26-123457", unit: "CMOTHER1" },
  ];
  const db = {
    from() { return {
      select() { return { in(_column: string, ids: string[]) {
        lookups.push(ids);
        return Promise.resolve({ data: rows, error: null });
      } }; },
      update() { return { in(_column: string, ids: string[]) {
        updates.push(ids);
        return Promise.resolve({ data: null, error: null });
      } }; },
    }; },
  } as unknown as SupabaseClient;
  await applyStandDowns(db, [
    parseStandDown("LHBENWE9 - 26-123456 - STOP")!,
    parseStandDown("26-123457 - STOP MESSAGE")!,
  ], "test");
  assert.deepEqual(lookups, [["26-123456", "26-123457"]]);
  assert.deepEqual(updates, [["a"], ["c"]]);
});

// A stand-down whose text names no brigade used to stand the WHOLE job down.
// Real example, job 26-127771: the RFS stop template drops the leading station
// code, so the only thing identifying the brigade is the pager it landed on —
// which the source reports as the page's origin. That origin also sits on the
// turnout page the same brigade got, so it names the row to cancel.
function db(rows: { id: string; incident_no: string; unit: string }[],
            turnouts: { incident_no: string; origin: string; raw: string }[],
            updates: string[][]) {
  const table = (name: string) => ({
    select() {
      const result = name === "incidents"
        ? { data: rows, error: null }
        : { data: turnouts, error: null };
      const chain: Record<string, unknown> = {
        in: () => chain,
        eq: () => chain,
        then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
      };
      return chain;
    },
    update() {
      return { in(_c: string, ids: string[]) {
        updates.push(ids);
        return Promise.resolve({ data: null, error: null });
      } };
    },
  });
  return { from: (name: string) => table(name) } as unknown as SupabaseClient;
}

test("a unit-less stand-down cancels only the brigade whose pager it reached", async () => {
  const updates: string[][] = [];
  await applyStandDowns(
    db(
      [
        { id: "ocv", incident_no: "26-127771", unit: "CMOCV" },
        { id: "kentl", incident_no: "26-127771", unit: "CMKENTL1" },
        { id: "appin", incident_no: "26-127771", unit: "SHAPPIN1" },
      ],
      [
        { incident_no: "26-127771", origin: "(Cumberland) - Comms Brigade",
          raw: "12:06:26 CMOCV - 26-127771 - Bush Fire - FIRECALL - 206 GEORGES RIVER RD,KENTLYN" },
        { incident_no: "26-127771", origin: "(Macarthur) - Kentlyn",
          raw: "CMKENTL1 - 26-127771 - Bush Fire - FIRECALL - GEORGES RIVER RD,FRERES RD,KENTLYN" },
      ],
      updates,
    ),
    [parseStandDown(
      "12:49:52 26-127771 - Bush Fire - FIRECALL - GEORGES RIVER RD,FRERES RD,KENTLYN,"
        + "CAMPBELLTOWN CITY (NSW),2560 - STOP MESSAGE - NNTA THANKS",
      "(Cumberland) - Comms Brigade",
    )!],
    "test",
  );
  assert.deepEqual(updates, [["ocv"]]);
});

test("an origin covering every unit on the job still stands the whole job down", async () => {
  // A district Duty Officer capcode receives a copy of every brigade's page, so
  // its origin sits on all of them and singles out nobody. Narrowing to "all
  // rows" is no narrowing at all — fall through to the whole incident.
  const updates: string[][] = [];
  await applyStandDowns(
    db(
      [
        { id: "a", incident_no: "26-123643", unit: "CMCOBBI" },
        { id: "b", incident_no: "26-123643", unit: "CMDO" },
      ],
      [
        { incident_no: "26-123643", origin: "(Macarthur) - Duty Officer",
          raw: "CMCOBBI - 26-123643 - Assist public - INCIDENT CALL - COBBITTY RD" },
        { incident_no: "26-123643", origin: "(Macarthur) - Duty Officer",
          raw: "CMDO - 26-123643 - Assist public - INCIDENT CALL - COBBITTY RD" },
      ],
      updates,
    ),
    [parseStandDown(
      "26-123643 - Assist public - INCIDENT CALL - COBBITTY RD,CHITTICK LANE,COBBITTY,"
        + "CAMDEN (NSW),2570 - STOP MESSAGE - NNTA THANK YOU",
      "(Macarthur) - Duty Officer",
    )!],
    "test",
  );
  assert.deepEqual(updates, [["a", "b"]]);
});

test("a stand-down with no origin to go on still stands the whole job down", async () => {
  const updates: string[][] = [];
  await applyStandDowns(
    db(
      [
        { id: "a", incident_no: "26-123527", unit: "CCTREE1" },
        { id: "b", incident_no: "26-123527", unit: "CCDO2" },
      ],
      [],
      updates,
    ),
    [parseStandDown("STOP MESSAGE - STOP FROM TMC - RFS NOT REQ - 26-123527 - Tree Down")!],
    "test",
  );
  assert.deepEqual(updates, [["a", "b"]]);
});
