import type { Incident, PagerMessage, RawStatus } from "./types";
import { parsePagerMessage, hasIncidentNumber } from "./parser";
import { parseStandDown, applyStandDowns, type StandDown } from "./standdown";
import { passesBoardFilter } from "./filter";
import { recordRawMessages } from "./raw-feed";
import { collapseById, dropWeakerThanStored, type IncidentRow } from "./incident-merge";
import { attachFireWeather } from "./fbi";
import { withInferredOrigin } from "./origin";
import { toIncident } from "./incident-row";
import { supabase } from "./supabase";

// ---------------------------------------------------------------------------
// Supabase-backed store.  All functions are async.
// The `incidents` table schema is in supabase/schema.sql.
// ---------------------------------------------------------------------------

// Only the columns the board actually renders/searches — keeps the payload
// lean so large pages stay fast. (Drops `fields`, `slacked_at`, etc.)
const LIST_COLUMNS =
  "id, incident_no, type, unit, location, coords, received_at, raw, stopped_at, " +
  "primary_fbi, secondary_fbi, fbi_station, fbi_distance_km, fbi_observed_at, fbi_observation";

// Columns a board search looks through. `raw` is the whole pager line and so
// covers most of it, but the parsed columns are searched in their own right:
// FRNSW type names are normalised on the way in (lib/type-names.ts), so the
// words the board displays — and therefore the words someone types — aren't
// always the words that came over the air.
const SEARCH_COLUMNS = ["incident_no", "type", "unit", "location", "raw"];

/**
 * A page of incidents, newest first. Pass the `(before, beforeId)` of the
 * oldest row you already have to fetch the next older page (keyset pagination:
 * fast at any depth, and no duplicate/skipped rows even on tied timestamps).
 *
 * `search` filters across the whole table rather than the page — the board's own
 * text filter can only see the rows it has loaded, which silently means "the
 * newest 200".
 */
export async function listIncidents(
  limit = 200,
  before?: string,
  beforeId?: string,
  search?: string,
): Promise<Incident[]> {
  let q = supabase
    .from("incidents")
    .select(LIST_COLUMNS)
    .order("received_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  // Same escaping as the raw feed below: drop the characters PostgREST uses to
  // separate filter values, then escape LIKE's wildcards, so a search for "%"
  // matches a literal % instead of everything and can't reshape the filter.
  // Trimmed again afterwards: a term made only of the stripped characters would
  // otherwise become a search for a run of spaces, which matches whatever happens
  // to be padded rather than nothing.
  const term = (search ?? "")
    .replace(/[\\,()]/g, " ")
    .replace(/[%_]/g, "\\$&")
    .trim();
  if (term) {
    q = q.or(SEARCH_COLUMNS.map((c) => `${c}.ilike.%${term}%`).join(","));
  }

  if (before) {
    // Rows strictly older than the (received_at, id) cursor. The tie-breaking
    // form is a second `or`, which can't be combined with the search's one, so a
    // searched page falls back to the timestamp alone — searches are served as a
    // single capped page (see the caller), so no cursor is in play there.
    q = beforeId && !term
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
  let lines = Array.isArray(input) ? input : [input];

  // The POST endpoint is a source like any other: record the unfiltered stream
  // into the raw feed before the board filter runs.
  await recordRawMessages(supabase, lines.map((raw) => ({ raw })), "api");

  // Board filter — matches feeder/poster.ts so a line POSTed here is treated
  // exactly as it would be arriving from a live source.
  lines = lines.filter(passesBoardFilter);
  if (lines.length === 0) return [];

  // Stand-down notices (STOP/STAND DOWN/NNTA) cancel resources on an existing
  // incident rather than being stored as a page of their own — pull them out
  // first so they never reach the parser (which would otherwise read "STOP" as
  // a real TYPE/location update and clobber the incident it refers to on
  // upsert).
  const standDowns = new Map<string, StandDown>();
  const normalLines: string[] = [];
  for (const line of lines) {
    const sd = parseStandDown(line);
    if (sd) standDowns.set(line.replace(/\s+/g, " ").trim(), sd);
    else normalLines.push(line);
  }
  await applyStandDowns(supabase, [...standDowns.values()], "api");

  const parsed: Incident[] = [];
  for (const line of normalLines) {
    const inc = parsePagerMessage(line);
    // Only numbered incidents (RFS + FRNSW) are stored — SES and any
    // number-less pages are dropped.
    if (inc && hasIncidentNumber(inc)) parsed.push(inc);
  }
  if (parsed.length === 0) return [];

  // Same floor the feeder applies (lib/incident-merge.ts): a POSTed line is a
  // source like any other, so a thin copy of a page mustn't overwrite a fuller
  // one already on the board. Lines POSTed here carry no timestamp of their own,
  // so within a batch the fullest copy simply wins.
  const rows = collapseById(
    parsed.map((inc) => ({
      hasTime: false,
      row: {
        id: inc.id,
        incident_no: inc.incidentNo,
        type: inc.type,
        unit: inc.unit,
        location: inc.location,
        coords: inc.coords,
        fields: inc.fields,
        received_at: inc.receivedAt,
        raw: inc.raw,
      } satisfies IncidentRow,
    })),
  ).map(({ row }) => row);

  // Nearest station's Fire Behaviour Index, for the RFS calls it applies to.
  const withFireWeather = await attachFireWeather(supabase, rows);

  const kept = await dropWeakerThanStored(supabase, withFireWeather, "api");
  if (kept.length === 0) return [];

  const { data, error } = await supabase
    .from("incidents")
    .upsert(kept, { onConflict: "id" })
    .select();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toIncident);
}

// ---------------------------------------------------------------------------
// Raw pager feed (`pager_messages`) — the unfiltered stream behind the board.
// Written by lib/raw-feed.ts:recordRawMessages(); read here for /api/raw.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPagerMessage(row: any): PagerMessage {
  // Rows backfilled from `incidents` carry no origin (it was never stored), so
  // recover what the line itself gives away. Stored values always win.
  const { agency, origin } = withInferredOrigin(row.raw ?? "", {
    agency: row.agency ?? null,
    origin: row.origin ?? null,
  });

  return {
    hash: row.hash,
    raw: row.raw,
    status: (row.status ?? "dropped") as RawStatus,
    incidentNo: row.incident_no ?? null,
    capcode: row.capcode ?? null,
    agency,
    origin,
    // "backfill" is a bookkeeping marker for rows reconstructed from the board,
    // not somewhere a page actually came from — don't surface it as a source.
    sources: (row.sources ?? []).filter((s: string) => s !== "backfill"),
    receivedAt: row.received_at,
    lastSeenAt: row.last_seen_at ?? row.received_at,
    seenCount: row.seen_count ?? 1,
  };
}

export interface RawFeedQuery {
  limit?: number;
  /** Keyset cursor: the (receivedAt, hash) of the oldest row you already have. */
  before?: string;
  beforeHash?: string;
  /** Free-text match against the line itself. */
  q?: string;
  /** Restrict to one classification. */
  status?: RawStatus;
  /** Every line the pipeline tied to this incident number. */
  incidentNo?: string;
}

/**
 * A page of the raw feed, newest first. Same keyset scheme as listIncidents —
 * fast at any depth, no duplicates or skips on tied timestamps.
 *
 * Search runs server-side (unlike the board's client-side filter) because this
 * table holds everything, so a useful search has to reach past the loaded page.
 */
export async function listPagerMessages({
  limit = 200,
  before,
  beforeHash,
  q,
  status,
  incidentNo,
}: RawFeedQuery = {}): Promise<PagerMessage[]> {
  let query = supabase
    .from("pager_messages")
    // `*` rather than a column list so this query keeps working against a
    // database that hasn't had the latest schema.sql applied yet — a missing
    // capcode/agency/origin column just reads as absent, and lib/origin.ts
    // fills what it can. Naming them would 500 the whole page instead. Every
    // column here is small except `raw`, which we need regardless.
    .select("*")
    .order("received_at", { ascending: false })
    .order("hash", { ascending: false })
    .limit(limit);

  if (status) query = query.eq("status", status);

  // The whole history of one job: initial page, every re-page to another
  // brigade, and the stand-down. Classification stamps `incident_no` on any
  // line it could read a number out of, whichever bucket it landed in, so this
  // catches dropped lines too.
  if (incidentNo) query = query.eq("incident_no", incidentNo);

  if (q) {
    // Drop the characters PostgREST uses to separate filter values, then escape
    // LIKE's wildcards, so a search for "%" matches a literal % instead of
    // everything and can't reshape the filter.
    const safe = q.replace(/[\\,()]/g, " ").replace(/[%_]/g, "\\$&");
    query = query.ilike("raw", `%${safe}%`);
  }

  if (before) {
    query = beforeHash
      ? query.or(`received_at.lt.${before},and(received_at.eq.${before},hash.lt.${beforeHash})`)
      : query.lt("received_at", before);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(toPagerMessage);
}

/** Wipe all incidents. */
export async function clearStore(): Promise<void> {
  const { error } = await supabase
    .from("incidents")
    .delete()
    .neq("id", "");
  if (error) throw new Error(error.message);
}
