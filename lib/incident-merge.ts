import type { SupabaseClient } from "@supabase/supabase-js";
import { lgaKeyFromLocation } from "./lga";

// ---------------------------------------------------------------------------
// Never trade a full record of a page for a thinner one.
//
// A board row is keyed on {incidentNo}-{unit}, so every source reporting the
// same page writes to the same row — and sources carry wildly different amounts
// of it. pager-feed.net truncates the address at the suburb and drops the
// coordinates; a lossy decode can cut a line off mid-word ("LHMULBR - 26-123414
// - Gr"). Without a floor, the board shows whichever copy happened to land last.
//
// Three losses are treated as disqualifying, because each is load-bearing
// rather than cosmetic:
//   coords   — the map pin and the Slack static map
//   LGA      — what a device that has narrowed to an area matches on
//   address  — the row's whole point; also the usual tell for a truncated decode,
//              which carries no coords to be caught by the first test either
//
// A copy that would surrender any of them is dropped whole rather than merged
// field-by-field: mixing them would pair one source's address with another's
// `raw`, and a row that no longer matches its own text is harder to trust than a
// slightly stale one. Anything else — a longer type string, different
// capitalisation — passes through. This is a floor, not a preference ordering.
// ---------------------------------------------------------------------------

/** The only parts of a row this comparison looks at. */
export interface RowFacts {
  location: string | null;
  coords: unknown;
}

/** Is `incoming` a poorer record of the same page than what's already stored? */
export function isWeakerThan(incoming: RowFacts, stored: RowFacts): boolean {
  const losesCoords = stored.coords != null && incoming.coords == null;

  const losesLga =
    lgaKeyFromLocation(stored.location ?? "") !== "" &&
    lgaKeyFromLocation(incoming.location ?? "") === "";

  // FRNSW pages carry no address at either end, so this stays quiet for them.
  const losesAddress =
    (stored.location ?? "").trim() !== "" && (incoming.location ?? "").trim() === "";

  return losesCoords || losesLga || losesAddress;
}

/**
 * Which of two records of the same job carries more of it.
 *
 * The floor above decides what may be *written*. This decides what to *show*
 * when a job's rows disagree — and they routinely do, because a row is one
 * {incident, unit}: the copy paged to the duty officer often arrives from a feed
 * that drops the coordinates and truncates the address at the suburb, while the
 * copy paged to the responding brigade carries both.
 *
 * Unlike isWeakerThan() this is a total order — it always names a winner — and
 * it ranks coordinates above all else, since that is what puts the pin on the
 * map. It compares whole rows and returns a whole row, so what ends up on screen
 * always comes from one page rather than being stitched together from several.
 * Ties keep `a`, so the caller controls the fallback.
 */
export function fullerOf<T extends { location: string; coords: unknown }>(a: T, b: T): T {
  if (!!a.coords !== !!b.coords) return a.coords ? a : b;

  const aHasLga = lgaKeyFromLocation(a.location) !== "";
  const bHasLga = lgaKeyFromLocation(b.location) !== "";
  if (aHasLga !== bHasLga) return aHasLga ? a : b;

  return a.location.trim().length >= b.location.trim().length ? a : b;
}

/** A row on its way to `incidents` — the shape both write paths build. */
export interface IncidentRow extends RowFacts {
  id: string;
  location: string;
  [k: string]: unknown;
}

/**
 * Collapse rows that share an id within one batch, keeping the fullest copy.
 * `hasTime` breaks a tie between two equally full copies — a source that gave us
 * no timestamp fell back to now(), which would scramble the board's ordering.
 */
export function collapseById<T extends { row: IncidentRow; hasTime: boolean }>(
  entries: T[],
): T[] {
  const byId = new Map<string, T>();

  for (const e of entries) {
    const held = byId.get(e.row.id);
    if (!held) {
      byId.set(e.row.id, e);
      continue;
    }
    if (isWeakerThan(e.row, held.row)) continue;            // keep what we hold
    if (isWeakerThan(held.row, e.row)) {                    // take the fuller copy
      byId.set(e.row.id, e);
      continue;
    }
    if (!held.hasTime && e.hasTime) byId.set(e.row.id, e);  // equally full
  }

  return [...byId.values()];
}

/**
 * Filter a batch down to the rows worth writing, comparing each against what's
 * already stored under the same id. Best-effort: if the lookup fails we write
 * the batch unchanged rather than stall ingestion on it.
 *
 * NOTE: this is a read followed by a write, so it is only as safe as the caller
 * makes it — see the write lock in feeder/poster.ts.
 */
export async function dropWeakerThanStored(
  db: SupabaseClient,
  rows: IncidentRow[],
  source: string,
): Promise<IncidentRow[]> {
  const ids = rows.map((r) => r.id);
  const stored = new Map<string, RowFacts>();

  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db
      .from("incidents")
      .select("id, location, coords")
      .in("id", ids.slice(i, i + 200));
    if (error) {
      console.error(`[${source}] compare stored:`, error.message);
      return rows;
    }
    for (const r of data ?? []) stored.set(r.id, { location: r.location, coords: r.coords });
  }

  const kept: IncidentRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    const prior = stored.get(row.id);
    if (prior && isWeakerThan(row, prior)) dropped++;
    else kept.push(row);
  }
  if (dropped) console.log(`[${source}] kept ${dropped} stored row(s) over a thinner copy`);
  return kept;
}
