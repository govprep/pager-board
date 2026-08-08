import { frnswTurnoutLabel } from "./frnsw-stations";

// Where a pager message came from.
//
// The good case is the source telling us directly — rfspager.app has Capcode /
// Agency / Brigade columns, PagerMon returns address / agency / alias, and both
// agree on the shape ("0125111", "FRNSW", "251 Cardiff"). Those are captured at
// ingestion and stored on the row.
//
// This module is the fallback for rows that have none: everything backfilled
// from `incidents` (which never stored it), plus any source that goes quiet on
// the metadata. We recover what we can from the line's own text.

export interface Origin {
  /** Issuing agency, e.g. "FRNSW" or an RFS district. */
  agency: string | null;
  /** Responding brigade/station, e.g. "428 QUEANBEYAN" or "LHFINBA7". */
  origin: string | null;
}

// FRNSW pages are "FRINC TYPE: <type> TURNOUT: <num> [<num> …] INC: <no>".
const FRNSW_TURNOUT_RE = /\bTURNOUT:\s*([\d\s]+?)(?=\s+(?:LOC|INC):|\s*$)/i;

// RFS positional pages are "{alarmLevel} {stationCode} - {incidentNo} - …", and
// some sources prefix a clock time on top of that. Both are optional, so skip
// past either before taking the station code:
//   "LHFINBA7 - 26-123357 - …"           -> LHFINBA7
//   "2 STSUTTO - 26-118273 - …"          -> STSUTTO   (2 = alarm level)
//   "06:45:34 CMHORPA1A - 26-123354 - …" -> CMHORPA1A
const RFS_CODE_RE =
  /^(?:\d{1,2}:\d{2}(?::\d{2})?\s+)?(?:\d+\s+)?([A-Z][A-Z0-9./]{3,})\s+-\s+/;

/**
 * Best-effort agency/brigade for a raw line, used only when the source didn't
 * supply them. Returns nulls rather than guessing when the line gives us
 * nothing solid — a blank cell is better than a wrong brigade.
 */
export function inferOrigin(raw: string): Origin {
  const line = (raw ?? "").trim();
  if (!line) return { agency: null, origin: null };

  // FRNSW: expand the turnout number(s) into station names where we know them.
  const turnout = line.match(FRNSW_TURNOUT_RE);
  if (turnout) {
    const nums = turnout[1].trim().split(/\s+/).filter(Boolean);
    const labels = nums.map(frnswTurnoutLabel).filter(Boolean);
    if (labels.length) return { agency: "FRNSW", origin: labels.join(", ") };
  }
  if (/^FRINC\b/i.test(line)) return { agency: "FRNSW", origin: null };

  // RFS: the leading station code is all we can recover without a brigade table.
  const rfs = line.match(RFS_CODE_RE);
  if (rfs) return { agency: null, origin: rfs[1] };

  return { agency: null, origin: null };
}

/** Fill in blanks on a stored row from the line itself. Stored values win. */
export function withInferredOrigin(
  raw: string,
  stored: Partial<Origin>,
): Origin {
  if (stored.agency && stored.origin) {
    return { agency: stored.agency, origin: stored.origin };
  }
  const guess = inferOrigin(raw);
  return {
    agency: stored.agency ?? guess.agency,
    origin: stored.origin ?? guess.origin,
  };
}
