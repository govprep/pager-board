import { parsePagerMessage, hasIncidentNumber } from "./parser";

// A stand-down / cancellation notice: STOP or NNTA as their own token (not part
// of a longer word like STOPFORD or STOPPED — mirrors JUNK_RE in
// feeder/filter.ts), or the phrase "STAND DOWN".
const STANDDOWN_RE = /\bSTAND\s*DOWN\b|\bNNTA\b|\bSTOP\b/i;

/**
 * If `raw` is a stand-down notice, returns the incident number it refers to
 * (extracted and validated the same way a normal page's number is — see
 * hasIncidentNumber). Returns null if the line isn't a stand-down notice, or
 * carries no real incident number (e.g. plain noise like "STOP - NO NEED TO
 * ATTEND" with nothing structured to key off).
 */
export function standDownIncidentNo(raw: string): string | null {
  const line = (raw ?? "").trim();
  if (!line || !STANDDOWN_RE.test(line)) return null;
  const inc = parsePagerMessage(line);
  return inc && hasIncidentNumber(inc) ? inc.incidentNo.trim() : null;
}
