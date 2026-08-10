import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Stand-downs (STOP / STAND DOWN / NNTA).
//
// A stand-down is not a page of its own — it cancels a turnout that is already
// on the board, and usually cancels it for ONE brigade rather than for the whole
// job. Control routinely stands down some resources while the rest keep working,
// so the board records `stopped_at` per row (a row is one {incident, unit}) and
// colours that resource, instead of flagging the incident.
//
// The lines arrive in every arrangement the feeds can manage. Real examples:
//
//   LHBENWE9 - 26-123547 - Bush Fire - ... - STOP MESSAGE - NNTA THANK YOU
//   STOP MESSAGE - LHBENWE9 - 26-123547 - Bush Fire - RHONDDA ROAD, TERALBA
//   STOP///CMMIDDL1 - 26-123389 - Backyard fire - FIRECALL - RAMSAY RD,...
//   12:33:09 STOP MESSAGE//CMERSPA - 26-123386 - Unknown fire - FIRECALL - ...
//   26-123495 LHRAYTE7 Stop Message // NINE MILE CREEK RD ... - STOP ON INC
//   STOP MESSAGE - STOP FROM TMC - RFS NOT REQ - CCDO - 26-123527 - Tree Down
//   22:48:39 STOP MESSAGE - 26-123339 - MVA - 678-686 RICHMOND RD,...
//
// The brigade sits in a different slot in every one of them, so reading it by
// position is hopeless. Instead the line is reduced to a bag of tokens, and the
// brigade is whichever of the incident's ALREADY-STORED units the line mentions
// — see unitsNamedBy(). That needs no guess about what a brigade code looks
// like, and it cannot invent a unit the job never had. The last example names
// none of them, and correctly stands the whole incident down.
// ---------------------------------------------------------------------------

/** STOP or NNTA as their own token (not STOPFORD/STOPPED), or "STAND DOWN". */
const STANDDOWN_RE = /\bSTAND\s*DOWN\b|\bNNTA\b|\bSTOP\b/i;

// RFS incident numbers are "YY-NNNNNN". Anchored, so a street range ("678-686")
// and a phone number ("0055-3745") don't read as one.
const RFS_INC_RE = /^\d{2}-\d{3,}$/;

export interface StandDown {
  /** The incident the line cancels. */
  incidentNo: string;
  /** Every alphanumeric token in the line, uppercased — the bag matched against. */
  tokens: Set<string>;
}

/** Uppercased alphanumeric tokens; dashes kept so "26-123547" stays whole. */
function tokenise(line: string): string[] {
  return line.toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean);
}

/**
 * Read a stand-down line, or null if it isn't one (or names no incident we
 * could act on — plain noise like "STOP MESSAGE NO NEED TO ATTEND THANK YOU").
 */
export function parseStandDown(raw: string): StandDown | null {
  const line = (raw ?? "").trim();
  if (!line || !STANDDOWN_RE.test(line)) return null;

  const tokens = tokenise(line);

  // FRNSW carries the number under a key ("INC: 120047-14062026" — number and
  // date); RFS carries it as a bare token. Reading the key first keeps a bare
  // turnout number from being mistaken for the incident.
  const keyed = line.match(/\bINC\s*:\s*(\S+)/i)?.[1] ?? "";
  const fromKey = keyed.split("-")[0].trim();

  const incidentNo =
    (/^\d+$/.test(fromKey) ? fromKey : "") ||
    tokens.find((t) => RFS_INC_RE.test(t)) ||
    "";

  if (!incidentNo) return null;
  return { incidentNo, tokens: new Set(tokens) };
}

/**
 * If `raw` is a stand-down notice, the incident number it refers to. Kept for
 * the board filter and the raw feed's classifier, which only need to know that
 * the line is a stand-down and which job it belongs to.
 */
export function standDownIncidentNo(raw: string): string | null {
  return parseStandDown(raw)?.incidentNo ?? null;
}

/**
 * Which of `units` the line names. A unit is matched on its leading token, which
 * is the brigade code for RFS ("LHBENWE9") and the turnout number for FRNSW
 * ("428 QUEANBEYAN" -> "428"). Heads shorter than three characters are ignored:
 * a two-digit turnout is too easy to hit by accident, and falling back to the
 * whole incident is the safer miss.
 */
export function unitsNamedBy(sd: StandDown, units: string[]): string[] {
  return units.filter((u) => {
    const head = (u ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    return head.length >= 3 && sd.tokens.has(head);
  });
}

/**
 * Stamp `stopped_at` on the rows each stand-down cancels: just the brigades the
 * line names, or the whole incident when it names none.
 *
 * Best-effort — a stand-down that can't be applied is logged and skipped rather
 * than failing the batch it arrived in.
 */
export async function applyStandDowns(
  db: SupabaseClient,
  standDowns: StandDown[],
  source: string,
): Promise<void> {
  if (!standDowns.length) return;
  const stoppedAt = new Date().toISOString();
  let units = 0;
  let whole = 0;

  for (const sd of standDowns) {
    const { data, error } = await db
      .from("incidents")
      .select("id, unit")
      .eq("incident_no", sd.incidentNo);
    if (error) {
      console.error(`[${source}] stand-down lookup:`, error.message);
      continue;
    }

    const rows = data ?? [];
    if (!rows.length) continue; // cancels a job we never saw

    const named = rows.filter((r) => unitsNamedBy(sd, [r.unit ?? ""]).length > 0);
    const targets = named.length ? named : rows;
    if (named.length) units += named.length;
    else whole++;

    const { error: updateError } = await db
      .from("incidents")
      .update({ stopped_at: stoppedAt })
      .in("id", targets.map((r) => r.id));
    if (updateError) console.error(`[${source}] stand-down update:`, updateError.message);
  }

  if (units || whole) {
    console.log(
      `[${source}] stood down ${units} resource(s)` +
        (whole ? ` and ${whole} whole incident(s)` : ""),
    );
  }
}
