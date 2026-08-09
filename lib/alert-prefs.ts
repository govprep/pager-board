// Per-device notification preferences: which incidents are worth a buzz.
//
// A device chooses areas two ways, because the two agencies page differently:
//
//   RFS   pages carry a full address, whose LGA segment we match ("WINGECARRIBEE").
//   FRNSW pages carry NO address at all — just "TURNOUT: 357 INC: 155212-09082026"
//         — so they can only be matched by station/turnout number.
//
// The two lists are independent and OR'd: an incident alerts a device if its LGA
// is on the device's LGA list, or any of its turnouts is on its station list.
// Picking an LGA therefore does not imply the FRNSW stations inside it; those
// are chosen by number.
//
// `alertAll` is the default and preserves the original behaviour (every device
// gets every incident), so existing subscribers keep working until they narrow.

import { lgaKey, lgaKeyFromLocation } from "./lga";
import { frnswTurnouts, turnoutKey } from "./frnsw-stations";

export interface AlertPrefs {
  /** Send everything, ignoring the lists below. */
  alertAll: boolean;
  /** LGA names as picked/typed, e.g. ["WINGECARRIBEE", "Central Coast"]. */
  lgas: string[];
  /** FRNSW turnout numbers, normalised, e.g. ["428", "385"]. */
  stations: string[];
}

export const DEFAULT_PREFS: AlertPrefs = { alertAll: true, lgas: [], stations: [] };

// Generous caps — they exist to stop a malformed or hostile request storing an
// unbounded array, not to constrain real use (NSW has ~128 LGAs, 335 stations).
const MAX_LGAS = 200;
const MAX_STATIONS = 400;
const MAX_LEN = 80;

function cleanList(value: unknown, max: number, map: (s: string) => string): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const v = map(item.trim().slice(0, MAX_LEN));
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Coerce untrusted request JSON into stored preferences. Never throws. */
export function sanitizePrefs(body: unknown): AlertPrefs {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    alertAll: b.alertAll !== false, // anything but an explicit false means "all"
    lgas: cleanList(b.lgas, MAX_LGAS, (s) => s.toUpperCase()),
    // Stations are stored normalised so "0428" and "428" can't both be held.
    stations: cleanList(b.stations, MAX_STATIONS, (s) =>
      /^\d{1,4}$/.test(s) ? turnoutKey(s) : "",
    ),
  };
}

/**
 * What a page offers for matching: its LGA key (RFS) and turnout keys (FRNSW).
 * One or both can be empty — a FRNSW page has no LGA, and an RFS page with no
 * usable address has neither.
 */
export interface AlertKeys {
  lgaKey: string;
  stationKeys: string[];
}

export function alertKeysFor(location: string, raw: string): AlertKeys {
  return {
    lgaKey: lgaKeyFromLocation(location),
    stationKeys: frnswTurnouts(raw).map(turnoutKey).filter(Boolean),
  };
}

/** Merge the keys of every page of one incident (units page in separately). */
export function mergeAlertKeys(all: AlertKeys[]): AlertKeys {
  const stations = new Set<string>();
  let lga = "";
  for (const k of all) {
    if (!lga && k.lgaKey) lga = k.lgaKey;
    for (const s of k.stationKeys) stations.add(s);
  }
  return { lgaKey: lga, stationKeys: [...stations] };
}

/**
 * Does this device want to hear about this incident?
 *
 * Note a narrowed device hears nothing from a page that yields neither an LGA
 * nor a turnout (a handful of RFS pages arrive with no usable address). That's
 * the cost of filtering; `alertAll` devices are unaffected.
 */
export function wantsIncident(prefs: AlertPrefs, keys: AlertKeys): boolean {
  if (prefs.alertAll) return true;

  if (keys.lgaKey) {
    for (const l of prefs.lgas) {
      if (lgaKey(l) === keys.lgaKey) return true;
    }
  }
  if (keys.stationKeys.length && prefs.stations.length) {
    const wanted = new Set(prefs.stations.map(turnoutKey));
    for (const s of keys.stationKeys) if (wanted.has(s)) return true;
  }
  return false;
}
