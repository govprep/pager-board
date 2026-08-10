// Which resources on a job are appliances, and which are people.
//
// A board row is one {incident, unit}, and pager-feed.net in particular hears
// the capcodes the other sources miss — duty officers and operational support
// especially (LHDO, CCDO, SHDO, LHOPS18, SHOPS14). Those are a big share of the
// unit pages that arrive *after* a job has already alerted, and they say nothing
// about the response: a duty officer is paged to almost everything in the zone,
// so "SHDO was added to RINGWOOD RD" is noise where "CMEASCR1 was added" is news.
//
// So the follow-up alert (feeder/push.ts) counts appliances only. The pages are
// still stored and still shown on the card — this decides what's worth a buzz,
// not what's worth keeping.
//
// RFS unit codes are a zone prefix plus a brigade abbreviation plus a fleet
// number (LHBENWE9 = Lower Hunter / Bennington / 9). The support codes replace
// the brigade-and-number with a role: zone + DO, or zone + OPS + a number.
// FRNSW units are "<turnout> <STATION>" ("428 QUEANBEYAN"), whose leading token
// is numeric — no role code can be mistaken for one, so they always read as
// appliances, which is what they are.
//
// The match is deliberately tight rather than a substring test: DO and OPS as
// bare substrings appear inside real brigade names (a "CCDOOR1" out of Dooralong
// would fail a `includes("DO")` test), so the role has to be the *whole* tail of
// the code.
const SUPPORT_UNIT_RE = /^[A-Z]{2,4}(?:DO|OPS)\d*$/;

/**
 * Is this unit a duty officer or operational support rather than an appliance?
 * Matches on the leading token, as the stand-down reader does, so a FRNSW unit
 * is judged on its turnout number and not its station name.
 */
export function isSupportUnit(unit: string): boolean {
  const head = (unit ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  return SUPPORT_UNIT_RE.test(head);
}

/** The appliances among `units`, in order, dropping blanks and support codes. */
export function applianceUnits(units: string[]): string[] {
  return units.filter((u) => u?.trim() && !isSupportUnit(u));
}
