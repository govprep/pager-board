import type { Incident } from "./types";
import { parsePagerMessage } from "./parser";
import { SAMPLE_PAGER_LINES, sampleReceivedAt } from "./sample-data";

// ---------------------------------------------------------------------------
// Data source seam.
//
// Today this is a process-memory store seeded with sample data. It is the ONE
// place to swap in Supabase later: implement the same four functions against a
// `incidents` table (see lib/supabase.ts and README) and nothing else changes —
// the API routes and UI only ever call listIncidents() / addRawMessages().
// ---------------------------------------------------------------------------

declare global {
  // Persist across HMR / route invocations in dev.
  // eslint-disable-next-line no-var
  var __pagerStore: Map<string, Incident> | undefined;
  // eslint-disable-next-line no-var
  var __pagerStoreSeeded: boolean | undefined;
}

function seed(): Map<string, Incident> {
  const map = new Map<string, Incident>();
  SAMPLE_PAGER_LINES.forEach((line, i) => {
    const inc = parsePagerMessage(line, sampleReceivedAt(i, SAMPLE_PAGER_LINES.length));
    if (inc) map.set(inc.id, inc);
  });
  return map;
}

function store(): Map<string, Incident> {
  if (!globalThis.__pagerStoreSeeded) {
    globalThis.__pagerStore = seed();
    globalThis.__pagerStoreSeeded = true;
  }
  return globalThis.__pagerStore!;
}

/** Wipe all incidents. The store stays empty (does not re-seed with sample data). */
export function clearStore(): void {
  globalThis.__pagerStore = new Map();
  globalThis.__pagerStoreSeeded = true;
}

/** All incidents, newest first. */
export function listIncidents(): Incident[] {
  return [...store().values()].sort(
    (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt),
  );
}

export function getIncident(id: string): Incident | undefined {
  return store().get(id);
}

/**
 * Ingest one or more raw pager lines. Returns the parsed incidents that were
 * added/updated. This is what a real pager feed would POST to.
 */
export function addRawMessages(input: string | string[]): Incident[] {
  const lines = Array.isArray(input) ? input : [input];
  const added: Incident[] = [];
  const s = store();
  for (const line of lines) {
    const inc = parsePagerMessage(line);
    if (inc) {
      const existing = s.get(inc.id);
      if (existing) inc.receivedAt = existing.receivedAt;
      s.set(inc.id, inc);
      added.push(inc);
    }
  }
  return added;
}
