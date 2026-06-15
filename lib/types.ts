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
}
