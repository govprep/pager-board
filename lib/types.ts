// Domain types for the pager incident board — kept deliberately small.
// Pager lines come in different shapes; we only promise the handful of fields
// that are reliably present. Anything extra a line carries lands in `fields`.

export interface Coords {
  lng: number;
  lat: number;
}

export interface Incident {
  /** Stable id — the incident number when we have one. */
  id: string;
  incidentNo: string;
  /** Nature of the job, e.g. "AFA", "Chimney fire", "STRUCTURE FIRE". */
  type: string;
  /** Responding unit / turnout / station, e.g. "428", "STSUTTO". */
  unit: string;
  /** Free-text location/address if the line carried one, else "". */
  location: string;
  /** Coordinates if present, else null. */
  coords: Coords | null;
  /** ISO timestamp the message was received/ingested. */
  receivedAt: string;
  /** Any other KEY: value pairs the parser pulled out (kept for display/audit). */
  fields: Record<string, string>;
  /** Original untouched pager line. */
  raw: string;
  /** When a STOP/STAND DOWN/NNTA message flagged this incident, else null. */
  stoppedAt: string | null;
}

/**
 * What the ingest pipeline did with a raw pager line.
 *   incident  — parsed into a numbered job and upserted onto the board
 *   standdown — a STOP / STAND DOWN / NNTA that flagged an existing incident
 *   dropped   — everything else: SES traffic, decode noise, test pages, and
 *               number-less pages the board deliberately doesn't show
 */
export type RawStatus = "incident" | "standdown" | "dropped";

/**
 * One deduplicated line of the raw pager feed. Unlike `Incident`, this is every
 * line every source saw — nothing is filtered out. Identical lines collapse into
 * a single row (keyed by a hash of the whitespace-normalised text), so a page
 * picked up by three sources is one row listing all three.
 */
export interface PagerMessage {
  /** sha256 of the whitespace-normalised line — the dedup key. */
  hash: string;
  /** The line as it arrived (first copy seen wins). */
  raw: string;
  status: RawStatus;
  /** The incident number the line refers to, when it carries one. */
  incidentNo: string | null;
  /** Pager capcode the message was sent to, e.g. "0125111". */
  capcode: string | null;
  /** Issuing agency, e.g. "FRNSW", "Lower Hunter". */
  agency: string | null;
  /** Responding brigade/station, e.g. "251 Cardiff", "428 QUEANBEYAN". */
  origin: string | null;
  /** Every feeder source that has reported this line, e.g. ["pocsag","telegram"]. */
  sources: string[];
  /** Earliest known time for the message itself (not the time we stored it). */
  receivedAt: string;
  /** Most recent time a source re-reported this exact line. */
  lastSeenAt: string;
  /** How many times this exact line has been reported across all sources. */
  seenCount: number;
}
