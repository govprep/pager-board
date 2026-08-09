// Local Government Area — pulled out of an RFS address so a device can subscribe
// to "everything in Wingecarribee".
//
// RFS addresses are comma-separated and end with the LGA + postcode, but the
// number of leading parts varies (a cross-street or a road name can add one):
//
//   15 GREYLEIGH DR,KIAMA,KIAMA (NSW),2533                            -> 4 parts
//   B88 (PICTON RD),MOUNT KEIRA RD,CORDEAUX,WOLLONGONG CITY (NSW),2526 -> 5 parts
//
// So the LGA is found by its "(STATE)" parenthetical rather than by position —
// indexing from the front picks the suburb on the longer form. Lines with no
// such segment (every FRNSW page: they carry no address at all) yield null.
//
// Matching is done on a normalised key, because the same LGA is not spelled
// consistently across sources or against any official list:
//   "QUEANBEYAN PALERANG"  ==  "Queanbeyan-Palerang Regional"
//   "LAKE MACQUARIE CITY"  ==  "Lake Macquarie"
//   "MOIRA SHIRE COUNCIL"  ==  "Moira"

import { LGA_ALIASES } from "./nsw-lgas";

const STATE_SEGMENT_RE = /\((?:NSW|ACT|VIC|QLD|SA|NT|TAS|WA)\)/i;

// Generic council-type suffixes, stripped from the end of a name before
// comparing. Only trailing tokens are removed, so real names that merely
// contain one of these words ("THE HILLS") are untouched.
const SUFFIXES = new Set(["COUNCIL", "SHIRE", "CITY", "REGIONAL", "MUNICIPALITY", "AREA"]);

/**
 * The LGA a location sits in, as the page spells it ("CENTRAL COAST",
 * "WINGECARRIBEE"), or null when the address carries no LGA segment.
 */
export function lgaFromLocation(location: string): string | null {
  if (!location) return null;
  for (const part of location.split(",")) {
    const seg = part.trim();
    if (!STATE_SEGMENT_RE.test(seg)) continue;
    const name = seg.replace(STATE_SEGMENT_RE, "").trim();
    if (name) return name.toUpperCase();
  }
  return null;
}

/**
 * Comparison key for an LGA name — case, punctuation and council-type suffixes
 * removed, so the feed's spelling matches whatever the user picked or typed.
 * Returns "" for input that normalises to nothing.
 */
export function lgaKey(name: string): string {
  const tokens = (name ?? "")
    .toUpperCase()
    .replace(STATE_SEGMENT_RE, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  // Drop trailing generic words, but never the last remaining token — otherwise
  // an LGA legitimately named "City" style would normalise away to nothing.
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();

  // Fold the feed's recurring misspellings onto the real area, so a device
  // watching Campbelltown still hears about pages that say "CAMPELLTOWN".
  const key = tokens.join(" ");
  return LGA_ALIASES[key] ?? key;
}

/** The LGA match key for a location, or "" when it carries no LGA. */
export function lgaKeyFromLocation(location: string): string {
  const name = lgaFromLocation(location);
  return name ? lgaKey(name) : "";
}
