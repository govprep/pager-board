import type { Incident } from "./types";
import { parsePagerMessage, hasIncidentNumber } from "./parser";
import { supabase } from "./supabase";

// ---------------------------------------------------------------------------
// Supabase-backed store.  All functions are async.
// The `incidents` table schema is in supabase/schema.sql.
// ---------------------------------------------------------------------------

// Map DB row (snake_case) → Incident (camelCase)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIncident(row: any): Incident {
  return {
    id: row.id,
    incidentNo: row.incident_no,
    type: row.type,
    unit: row.unit,
    location: row.location,
    coords: row.coords ?? null,
    receivedAt: row.received_at,
    fields: row.fields ?? {},
    raw: row.raw,
  };
}

// Only the columns the board actually renders/searches — keeps the payload
// lean so large pages stay fast. (Drops `fields`, `slacked_at`, etc.)
const LIST_COLUMNS = "id, incident_no, type, unit, location, coords, received_at, raw";

/**
 * A page of incidents, newest first. Pass the `(before, beforeId)` of the
 * oldest row you already have to fetch the next older page (keyset pagination:
 * fast at any depth, and no duplicate/skipped rows even on tied timestamps).
 */
export async function listIncidents(
  limit = 200,
  before?: string,
  beforeId?: string,
): Promise<Incident[]> {
  let q = supabase
    .from("incidents")
    .select(LIST_COLUMNS)
    .order("received_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (before) {
    // Rows strictly older than the (received_at, id) cursor.
    q = beforeId
      ? q.or(`received_at.lt.${before},and(received_at.eq.${before},id.lt.${beforeId})`)
      : q.lt("received_at", before);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map(toIncident);
}

export async function getIncident(id: string): Promise<Incident | undefined> {
  const { data, error } = await supabase
    .from("incidents")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return undefined;
  return toIncident(data);
}

/**
 * Ingest one or more raw pager lines. Returns the parsed incidents that were
 * upserted. Duplicate incident IDs are updated in place.
 */
export async function addRawMessages(input: string | string[]): Promise<Incident[]> {
  const lines = Array.isArray(input) ? input : [input];
  const parsed: Incident[] = [];
  for (const line of lines) {
    const inc = parsePagerMessage(line);
    // Only numbered incidents (RFS + FRNSW) are stored — SES and any
    // number-less pages are dropped.
    if (inc && hasIncidentNumber(inc)) parsed.push(inc);
  }
  if (parsed.length === 0) return [];

  const rows = parsed.map((inc) => ({
    id: inc.id,
    incident_no: inc.incidentNo,
    type: inc.type,
    unit: inc.unit,
    location: inc.location,
    coords: inc.coords,
    fields: inc.fields,
    received_at: inc.receivedAt,
    raw: inc.raw,
  }));

  const { data, error } = await supabase
    .from("incidents")
    .upsert(rows, { onConflict: "id" })
    .select();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toIncident);
}

/** Wipe all incidents. */
export async function clearStore(): Promise<void> {
  const { error } = await supabase
    .from("incidents")
    .delete()
    .neq("id", "");
  if (error) throw new Error(error.message);
}
