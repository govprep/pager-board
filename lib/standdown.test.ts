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
