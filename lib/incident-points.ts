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
  /** An address with no coordinates on it, to be looked up as written. */
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

// The state parenthetical the RFS addresses carry ("YASS VALLEY (NSW)"). It is
// an LGA marker rather than part of the place name, and geocoders read it as
// noise at best.
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

/** Search text for an address that arrived without coordinates. */
export function addressQuery(location: string): string {
  return location
    .replace(STATE_SEGMENT_RE, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

/** Where to put this job, and how precisely we can claim to know. */
export function placeJob(job: MappableJob): Placement {
  if (job.coords) return { precision: "exact", coords: job.coords };

  const suburb = stationSuburb(job);
  if (suburb) {
    return {
      precision: "station",
      query: `${suburb}, NSW`,
      types: PLACE_TYPES,
      label: suburb,
    };
  }

  const query = addressQuery(job.location);
  if (query) {
    return { precision: "address", query, types: "", label: query };
  }

  return { precision: "none" };
}
