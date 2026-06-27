import type { Incident } from "./types";
import { parsePagerMessage, isFrnswIncident } from "./parser";
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

/** Most recent incidents, newest first. */
export async function listIncidents(limit = 30): Promise<Incident[]> {
  const { data, error } = await supabase
    .from("incidents")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(limit);
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
    // Only FRNSW incidents (FRINC + an incident number) are stored — SES and
    // any number-less pages are dropped.
    if (inc && isFrnswIncident(inc)) parsed.push(inc);
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
