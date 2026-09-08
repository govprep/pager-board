import type { Coords } from "./types";
import { frnswStationName, frnswTurnouts } from "./frnsw-stations";

// Where a job goes on the live map — and how honestly it can claim to be there.
//
// Only some of the traffic carries coordinates. RFS positional pages usually do;
// FRNSW pages carry no address and no coordinates at all, only the turnout
// number of the station that was sent:
//
//   FRINC TYPE: HOUSE FIRE TURNOUT: 428 INC: 155168-09082026
//
// which is most of the board. Dropping those off the map would leave it showing
// a fraction of what is happening, so they are placed on their station's suburb
// and marked as what they are: the suburb, not the job. The map draws those
// differently (a soft ring rather than a pin) and the card says so in words.
//
// Nothing here geocodes; this only decides *what to ask*. The asking, its cache
// and its failure handling are lib/geocode.ts.

export type Placement =
  /** The page's own coordinates — the pin is the incident. */
  | { precision: "exact"; coords: Coords }
  /** A FRNSW job placed on the responding station's suburb. Generic by nature. */
  | { precision: "station"; query: string; types: string; label: string }
  /** No coordinates, but the address names a suburb. Generic, and temporary:
      an RFS job's later pages usually do carry coordinates, and the pin moves
      to them when they land. */
  | { precision: "address"; query: string; types: string; label: string }
  /** Nothing on the page says where it is. */
  | { precision: "none" };

/** Everything the decision looks at. Satisfied by a merged board entry's job. */
export interface MappableJob {
  coords: Coords | null;
  location: string;
  /** Every resource paged to the job, as the board labels them ("428 QUEANBEYAN"). */
  units: string[];
  /** The page itself, for the FRNSW turnout when the units don't carry one. */
  raw: string;
}

// The state parenthetical the RFS addresses carry ("YASS VALLEY (NSW)"). It
// marks the LGA segment, which is what makes the segment in front of it the
// suburb — see suburbOf() below.
const STATE_SEGMENT_RE = /\s*\((?:NSW|ACT|VIC|QLD|SA|NT|TAS|WA|LGA)\)/gi;

// Suburb-and-town level. Without this a station called PENRITH can resolve to a
// street named Penrith on the other side of the country; with it, the answer is
// the place itself. Australian suburbs come back as `locality` inside a city and
// as `place` when they're a town of their own, so both are asked for.
const PLACE_TYPES = "place,locality,neighborhood";

/**
 * The station suburb a FRNSW job belongs to, or null when it isn't one (or names
 * a turnout we have no station for).
 *
 * Read off the units first, because the board has already expanded them
 * ("428 QUEANBEYAN"), and only then off the raw line — which is what covers a
 * row stored before that expansion existed. The first station that resolves
 * wins: a job paged to two stations is one pin either way, and this is the
 * approximate marker, not a claim about which appliance is where.
 */
export function stationSuburb(job: MappableJob): string | null {
  for (const unit of job.units) {
    const m = unit.trim().match(/^(\d{1,4})\s+(\S.*)$/);
    if (m) return m[2].trim();
  }
  for (const turnout of frnswTurnouts(job.raw)) {
    const name = frnswStationName(turnout);
    if (name) return name;
  }
  return null;
}

// Street-type words. A segment ending in one of these is a road, not a suburb —
// the guard for an address that never carried a suburb at all.
const STREET_SUFFIX_RE =
  /\b(?:ST|STREET|RD|ROAD|AVE?|AVENUE|HWY|HIGHWAY|DR|DRIVE|LANE|LN|PDE|PARADE|CRES|CRESCENT|CL|CLOSE|CT|COURT|PL|PLACE|WAY|TCE|TERRACE|CIR|CIRCUIT|GR|GROVE|TRL|TRACK|FIRE\s+TRAIL)\.?$/i;

/**
 * The suburb an RFS address is in, and its postcode.
 *
 * **Not** the street. This is the whole lesson of the first version, which
 * handed the address text to a geocoder as written and put jobs hundreds of
 * kilometres from where they were. These addresses are not written for a
 * geocoder:
 *
 *   MITCHELL HIGHWAY, BACK SWAMP ROAD, THE ROCKS            (a cross-street)
 *   AFA0071631,UR-3R WASTE MNGT FACILITY,WALLGROVE RD,…     (alarm no. + premises)
 *   CESSNOCK RD,DAVID ST,NEATH,CESSNOCK CITY (NSW),2326     (two road names)
 *   INCIDENT CA A&50Y$3#A(i                                 (a failed decode)
 *
 * Asked to place any of those, a geocoder answers *something* — "THE ROCKS"
 * being the one in Sydney rather than the one out past Bathurst. A wrong pin is
 * worse than no pin on a map people use to know where a job is.
 *
 * So the suburb is taken structurally rather than guessed at: these addresses
 * end `…,SUBURB,LGA (NSW),POSTCODE`, so the suburb is the segment in front of
 * the LGA marker, whatever the mess in front of it. No marker, no suburb, no
 * pin — the job waits for a page carrying coordinates, which for RFS traffic
 * usually follows within a few minutes.
 */
export function suburbOf(location: string): { suburb: string; postcode: string | null } | null {
  const parts = (location ?? "").split(",").map((p) => p.trim());
  const lga = parts.findIndex((p) => STATE_SEGMENT_RE.test(p));
  // findIndex over a /g regex: reset it, or the next call resumes mid-string.
  STATE_SEGMENT_RE.lastIndex = 0;
  if (lga < 1) return null;

  const suburb = parts[lga - 1].replace(/[^A-Za-z' -]+/g, " ").replace(/\s+/g, " ").trim();
  if (suburb.length < 2 || STREET_SUFFIX_RE.test(suburb)) return null;

  // The postcode is the strongest disambiguator these addresses carry, and a
  // fair number arrive with a truncated coords fragment stuck to it
  // ("2766 - [150."), so it's matched rather than taken whole.
  const postcode = parts.slice(lga + 1).join(" ").match(/\b(\d{4})\b/)?.[1] ?? null;
  return { suburb: suburb.toUpperCase(), postcode };
}

/** Search text for a suburb — with its postcode when the page carried one. */
export function suburbQuery(suburb: string, postcode: string | null): string {
  return postcode ? `${suburb}, NSW ${postcode}` : `${suburb}, NSW`;
}

/** Where to put this job, and how precisely we can claim to know. */
export function placeJob(job: MappableJob): Placement {
  if (job.coords) return { precision: "exact", coords: job.coords };

  const station = stationSuburb(job);
  if (station) {
    return {
      precision: "station",
      query: suburbQuery(station, null),
      types: PLACE_TYPES,
      label: station,
    };
  }

  const found = suburbOf(job.location);
  if (found) {
    return {
      precision: "address",
      query: suburbQuery(found.suburb, found.postcode),
      types: PLACE_TYPES,
      label: found.suburb,
    };
  }

  return { precision: "none" };
}
