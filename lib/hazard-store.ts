import type { Hazard, HazardCategory } from "./hazards";
import { supabase } from "./supabase";

// The read side of `hazards`. Small enough to be its own file rather than more
// of lib/store.ts, which is entirely about the board.

const LIST_COLUMNS =
  "id, source, external_id, category, headline, display_name, advice, is_major, " +
  "suburb, coords, geometry, roads, started_at, updated_at, ended_at, url";

interface HazardRow {
  id: string;
  source: string;
  external_id: string;
  category: string;
  headline: string;
  display_name: string;
  advice: string;
  is_major: boolean;
  suburb: string | null;
  coords: { lng: number; lat: number } | null;
  geometry: unknown;
  roads: unknown;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  url: string | null;
}

function toHazard(row: HazardRow): Hazard {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    category: row.category as HazardCategory,
    headline: row.headline,
    displayName: row.display_name,
    advice: row.advice,
    isMajor: row.is_major,
    suburb: row.suburb,
    coords: row.coords,
    geometry: row.geometry,
    roads: Array.isArray(row.roads) ? row.roads : [],
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    url: row.url,
    // Not selected: the whole feature is several KB and only the writer and a
    // later mapping fix ever read it.
    raw: null,
  };
}

/**
 * The open hazards, newest update first.
 *
 * No pagination and no keyset cursor, unlike listIncidents(): clipped to the
 * brigade's area this is tens of rows, not thousands, and the map wants all of
 * them at once or none — a half-drawn hazard layer is worse than no layer.
 */
export async function listOpenHazards(limit = 300): Promise<Hazard[]> {
  const { data, error } = await supabase
    .from("hazards")
    .select(LIST_COLUMNS)
    .is("ended_at", null)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => toHazard(row as unknown as HazardRow));
}
