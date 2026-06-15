import type { Incident, Coords } from "./types";

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
// An uppercase token immediately followed by a colon = a key.
const KEY_RE = /\b([A-Z][A-Z0-9]+)\s*:\s*/g;

function parseCoords(line: string): Coords | null {
  const m = line.match(COORDS_RE);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isNaN(lng) || Number.isNaN(lat) ? null : { lng, lat };
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

  const type = fields.TYPE ?? "";
  const unit =
    fields.TURNOUT ?? fields.UNIT ?? fields.STN ?? fields.STATION ?? "";
  const incRaw = fields.INC ?? fields.INCIDENT ?? "";
  const incidentNo = incRaw.split("-")[0]?.trim() || incRaw;
  const location = fields.LOC ?? fields.LOCATION ?? fields.ADDR ?? "";

  return {
    id: incidentNo || `${unit || "INC"}-${receivedAt}`,
    incidentNo,
    type,
    unit,
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
  const type = parts[2] ?? "";
  const callClass = parts[3] ?? "";

  const coords = parseCoords(line);
  const lastIsCoords = COORDS_RE.test(parts[parts.length - 1] ?? "");
  const addrEnd = lastIsCoords ? parts.length - 1 : parts.length;
  const location = parts.slice(4, addrEnd).join(" - ");

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
    id: incidentNo || `${unit}-${receivedAt}`,
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

/** Parse one raw pager line. Returns null only for empty input. */
export function parsePagerMessage(
  raw: string,
  receivedAt: string = new Date().toISOString(),
): Incident | null {
  const line = (raw ?? "").trim();
  if (!line) return null;
  const looksKeyValue = /\b[A-Z][A-Z0-9]+\s*:/.test(line);
  return looksKeyValue
    ? parseKeyValue(line, receivedAt)
    : parsePositional(line, receivedAt);
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
