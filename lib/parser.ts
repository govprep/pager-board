import type { Incident, Coords } from "./types";
import { frnswTurnoutLabel } from "./frnsw-stations";

// Pager lines come in (at least) two shapes. The parser sniffs which one it is
// and is forgiving about everything — a line it can't fully read still yields an
// incident with whatever fields it could find, rather than throwing.
//
//  A) Key/value  (most common, terse):
//       FRINC TYPE: AFA TURNOUT: 428 INC: 120047-14062026
//
//  B) Positional (the older "-" delimited form):
//       2 STSUTTO - 26-118273 - Chimney fire - FIRECALL - 10 NORTH ST,SUTTON,YASS VALLEY (NSW),2620 - [149.255855,-35.158894]

const COORDS_RE = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/;
// Bare "lng,lat" with no brackets — both numbers must have decimal points to
// avoid matching postcodes or street numbers.
const BARE_COORDS_RE = /^-?\d+\.\d+,-?\d+\.\d+$/;
// An uppercase token immediately followed by a colon = a key.
const KEY_RE = /\b([A-Z][A-Z0-9]+)\s*:\s*/g;

function parseCoords(line: string): Coords | null {
  const m = line.match(COORDS_RE);
  if (m) {
    const lng = Number(m[1]);
    const lat = Number(m[2]);
    return Number.isNaN(lng) || Number.isNaN(lat) ? null : { lng, lat };
  }
  // Handle bare "lng,lat" appended without brackets.
  const bm = line.match(/(-?\d+\.\d+),(-?\d+\.\d+)\s*$/);
  if (bm) {
    const a = Number(bm[1]);
    const b = Number(bm[2]);
    if (!Number.isNaN(a) && !Number.isNaN(b) && Math.abs(b) <= 90 && Math.abs(a) <= 180) {
      return { lng: a, lat: b };
    }
  }
  return null;
}

function parseKeyValue(line: string, receivedAt: string): Incident {
  const fields: Record<string, string> = {};
  const matches = [...line.matchAll(KEY_RE)];

  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1];
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : line.length;
    fields[key] = line.slice(start, end).trim();
  }

  const unit =
    fields.TURNOUT ?? fields.UNIT ?? fields.STN ?? fields.STATION ?? "";
  const incRaw = fields.INC ?? fields.INCIDENT ?? "";

  // SES detection: unit is "SES" or an SES callsign (SE + 1+ chars),
  // OR the INC field itself starts with an SES callsign + call type.
  const isSesUnit = /^SE[A-Z0-9]+/i.test(unit);
  const isSesInc = /^SE[A-Z0-9]{2,}\s+[A-Z]{2,}/i.test(incRaw);

  if (isSesUnit || isSesInc) {
    let sesUnit = unit;
    let sesType: string;
    let sesLocation: string;

    if (isSesInc) {
      // INC has "SEZWCB RCR description…" — extract type from first two tokens.
      const tokens = incRaw.split(/\s+/);
      sesUnit = tokens[0];
      sesType = `${tokens[0]} ${tokens[1] ?? ""}`.trim();
      sesLocation = incRaw.replace(/^SE\S+\s+\S+\s+(?:at\s+)?/i, "").trim();
    } else {
      // INC is a free-form description — use the callsign as the type identifier.
      sesType = unit;
      sesLocation = incRaw.replace(/\s+\d{2}\/\d{2}\s+\d{2}:\d{2}(:\d{2})?:?\s*$/i, "").trim();
    }

    return {
      id: `${sesUnit}-${receivedAt}`,
      incidentNo: "",
      type: sesType,
      unit: sesUnit,
      location: sesLocation,
      coords: parseCoords(line),
      receivedAt,
      fields,
      raw: line,
    };
  }

  const type = fields.TYPE ?? "";
  const incidentNo = incRaw.split("-")[0]?.trim() || incRaw;
  const location = fields.LOC ?? fields.LOCATION ?? fields.ADDR ?? "";

  // FRNSW pages (marked by "FRINC") identify the station by turnout number only —
  // look it up so the board shows "428 QUEANBEYAN" rather than a bare "428".
  // Unknown/non-numeric turnouts pass through unchanged.
  const displayUnit = /\bFRINC\b/i.test(line) ? frnswTurnoutLabel(unit) : unit;

  return {
    id: incidentNo
      ? unit ? `${incidentNo}-${unit}` : incidentNo
      : `${unit || "INC"}-${receivedAt}`,
    incidentNo,
    type,
    unit: displayUnit,
    location,
    coords: parseCoords(line),
    receivedAt,
    fields,
    raw: line,
  };
}

function parsePositional(line: string, receivedAt: string): Incident {
  const parts = line.split(" - ").map((p) => p.trim());
  const header = parts[0] ?? "";
  const incidentNo = parts[1] ?? "";
  let type = parts[2] ?? "";
  let callClass = parts[3] ?? "";

  // VRA (Volunteer Rescue Association) pages carry the agency in the type slot
  // and the real nature in the next segment, e.g. "VRA - ROAD CRASH RESCUE".
  // Promote that to the type and keep "VRA" as the class.
  if (/^VRA$/i.test(type) && callClass) {
    [type, callClass] = [callClass, type];
  }

  const coords = parseCoords(line);
  const lastPart = parts[parts.length - 1] ?? "";
  // Drop a trailing coords segment from the address — whether it parsed cleanly
  // or arrived truncated (e.g. a cut-off page ending in "[149.498"). Any part
  // starting with "[" is a coords fragment, never a real address tail.
  const lastIsCoords =
    COORDS_RE.test(lastPart) || BARE_COORDS_RE.test(lastPart) || lastPart.startsWith("[");
  const addrEnd = lastIsCoords ? parts.length - 1 : parts.length;
  // parts[3] is a callClass (e.g. "FIRECALL") when it has no comma and is all-caps.
  // If it contains a comma or lowercase it's the address itself (no callClass in this message).
  const p3 = parts[3] ?? "";
  const addrStart = p3.includes(",") || /[a-z]/.test(p3) ? 3 : 4;
  const location = parts.slice(addrStart, addrEnd).join(" - ");

  // Header is "{level} {station}" — keep the station as the unit.
  // Fall back to the first all-caps alphanumeric token (station code pattern)
  // so multi-word junk like "STOP MESSAGE THANK YOU" doesn't become the unit.
  const hm = header.match(/^\d+\s+(\S+)/);
  const unit = hm
    ? hm[1]
    : (header.split(/\s+/).find((t) => /^[A-Z][A-Z0-9]{1,}$/.test(t)) ?? header.split(/\s+/)[0] ?? header);

  const fields: Record<string, string> = {};
  if (callClass) fields.CLASS = callClass;

  return {
    id: incidentNo
      ? unit ? `${incidentNo}-${unit}` : incidentNo
      : `${unit}-${receivedAt}`,
    incidentNo,
    type: type || callClass,
    unit,
    location,
    coords,
    receivedAt,
    fields,
    raw: line,
  };
}

// SES callsigns start with SE followed by ≥2 alphanumeric chars, then a call-type word.
// e.g. "SEZWCB RCR MOTOR VEHICLE ACCIDENT AT YASS VALLEY WAY"
function isSesLine(line: string): boolean {
  return /^SE[A-Z0-9]+\s+[A-Z]{2,}/i.test(line) && !line.includes(" - ");
}

function parseSes(line: string, receivedAt: string): Incident {
  const tokens = line.trim().split(/\s+/);
  const unit = tokens[0] ?? "";
  const callType = tokens[1] ?? "";
  const location = tokens.slice(2).join(" ");
  return {
    id: `${unit}-${receivedAt}`,
    incidentNo: "",
    type: `${unit} ${callType}`.trim(),
    unit,
    location,
    coords: parseCoords(line),
    receivedAt,
    fields: {},
    raw: line,
  };
}

/**
 * The board only shows real incidents — ones that carry a proper incident
 * number (RFS "26-118273", FRNSW "120047"). A real number is a single token
 * containing at least one digit. This drops SES (no number at all) and pages
 * like ambulance/PTS free-text that get mis-parsed so the description lands in
 * the incident-number slot (it has spaces, so it fails here).
 */
export function hasIncidentNumber(inc: Incident): boolean {
  const v = inc.incidentNo.trim();
  return v !== "" && !/\s/.test(v) && /\d/.test(v);
}

/** Parse one raw pager line. Returns null only for empty input. */
export function parsePagerMessage(
  raw: string,
  receivedAt: string = new Date().toISOString(),
): Incident | null {
  const line = (raw ?? "").trim();
  if (!line) return null;
  if (/\b[A-Z][A-Z0-9]+\s*:/.test(line)) return parseKeyValue(line, receivedAt);
  if (isSesLine(line)) return parseSes(line, receivedAt);
  return parsePositional(line, receivedAt);
}

/** Parse many lines (a pasted dump or a batch from the feed). */
export function parsePagerBatch(input: string | string[]): Incident[] {
  const lines = Array.isArray(input) ? input : input.split(/\r?\n/);
  const out: Incident[] = [];
  for (const l of lines) {
    const inc = parsePagerMessage(l);
    if (inc) out.push(inc);
  }
  return out;
}
