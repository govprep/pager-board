import type { Incident } from "./types";
import { fullerOf, isLaterType } from "./incident-merge";

// How the board's rows become the jobs on screen.
//
// A stored row is one {incident, unit}: a job paged to six brigades is six rows,
// and the sources disagree about how much of the page each carries. Everything
// that reconciles those rows into one job — and the small view helpers that read
// a job's fields — lives here, because the board (components/PagerBoard.tsx) and
// the live map (components/LiveMap.tsx) have to draw the same picture from them.

/** The type-tag class for a job's nature — see the `.type-tag.*` rules in globals.css. */
export function typeClass(type: string): string {
  const t = type.toLowerCase();
  if (/fire|chimney|grass|bush|structure|blaze/.test(t)) return "fire";
  if (/mva|accident|rescue|collision|rcr/.test(t)) return "rescue";
  if (/hazmat|chemical|spill|gas/.test(t)) return "hazmat";
  if (/medical|patient|cardiac/.test(t)) return "medical";
  if (/storm|flood|tree|wire/.test(t)) return "storm";
  if (/afa|alarm|auto/.test(t)) return "afa";
  return "default";
}

// True on Apple platforms (iPhone/iPad/iPod, plus macOS — modern iPadOS reports

/** Every resource named in a unit string, as separate badges. */
// Split a unit string into the badges to display. FRNSW labels are
// "<number> STATION NAME" (e.g. "428 QUEANBEYAN") and must stay as a single
// badge — even when several are packed in one string after a merge
// ("357 LAMBTON 454 TARRO" -> two badges). Everything else is split into
// individual station codes (all-uppercase alphanumeric, 2+ chars).
export function unitTokens(unit: string): string[] {
  const u = unit.trim();
  if (!u) return [];
  if (/^\d+\s+[A-Z]/.test(u)) {
    const groups = u.match(/\d+\s+[A-Z][A-Z. ]*?(?=\s+\d|\s*$)/g);
    if (groups) return groups.map(g => g.trim());
    return [u];
  }
  const codes = u.split(/[\s,/]+/).filter(t => /^[A-Z0-9]{2,}$/.test(t));
  return codes.length > 0 ? codes : [u.split(/\s+/)[0]];
}

/** An address split into its street line and everything after it. */
export function splitAddress(loc: string): { street: string; locality: string } {
  if (!loc) return { street: "", locality: "" };
  const parts = loc.split(",");
  return {
    street: parts[0]?.trim() ?? "",
    locality: parts.slice(1).join(", ").trim(),
  };
}

// Combine two row lists, keyed by id (unique per incident+unit), newest first.
// Later lists win on conflict, so a refresh's fresh rows replace stale copies.
export function mergeById(...lists: Incident[][]): Incident[] {
  const byId = new Map<string, Incident>();
  for (const list of lists) for (const i of list) byId.set(i.id, i);
  return [...byId.values()].sort((a, b) =>
    a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
  );
}

// One resource paged to a job. `stopped` marks the ones a stand-down has since
// cancelled — control routinely stands some brigades down while the rest keep
// working, so this is per-resource rather than per-incident.
export type Unit = { name: string; stopped: boolean };

// One job as the board shows it: the key it's known by, its fullest details, and
// every resource paged to it.
export type Entry = { key: string; inc: Incident; units: Unit[] };

// Merge rows that share the same incident number into one display entry.
//
// A row is one {incident, unit}, so its `stoppedAt` belongs to that resource —
// it colours that badge and leaves the rest of the job alone.
//
// The job's own details come from its fullest row, not its newest. The rows
// disagree about how much of the page they carry: the copy paged to the duty
// officer often arrives from a feed that drops the coordinates and truncates
// the address at the suburb. Taking the newest meant a job could show no map
// pin and a half address while a sibling row had both.
//
// The time stays the earliest across the rows — that's when the job started,
// whichever page happens to describe it best.
//
// The type is the one exception to "fullest wins": control re-types a job as it
// develops (an AFA that turns out to be real is re-paged as a structure fire),
// and that update usually rides in on a *later, thinner* page than the one the
// rest of the row comes from. So the type is taken from the most recent page
// that carried one — see isLaterType().
//
// Resources come out in the order they joined the job, oldest first, so one
// arriving is appended on the right and every badge already there keeps its
// place. They can't simply be collected in row order: `rows` is sorted newest
// first, and that order is also what puts the newest job at the top of the board
// (mergeEntries' insertion order is the board's order — `grouped` never re-sorts
// it), so iterating the other way to fix the badges would flip the board. Each
// resource is stamped with the earliest page that mentioned it instead — when it
// actually joined — and the list is sorted on that at the end. The sort is
// stable, so resources sharing a page (a FRNSW turnout field naming several)
// keep the order that page listed them in.
//
// Used for what's on screen and, separately, for the board's change diff, which
// has to compare the same picture the board is drawing: a re-typed job and a
// fuller address both come out of the reconciliation here rather than off any
// single row.
export function mergeEntries(rows: Incident[]): Entry[] {
  // The working stamps the units are sorted on below; both are dropped on the
  // way out, so an Entry is exactly what it was before.
  //
  // `joinedAt` alone isn't enough. Several lines ingested in one request are
  // stamped by separate `new Date()` calls in a tight loop (lib/store.ts), so
  // they routinely land on the identical millisecond — and a stable sort over
  // ties leaves them in the order they were iterated, which is newest first.
  // A whole batch of resources would still read backwards. `seq` is the row's
  // position in `rows`, which for tied stamps is the order the pages came in,
  // so it breaks those ties back into page order.
  type Joined = Unit & { joinedAt: string; seq: number };
  const map = new Map<
    string,
    { key: string; inc: Incident; units: Joined[]; startedAt: string; typedBy: Incident }
  >();
  for (const [seq, i] of rows.entries()) {
    const key = i.incidentNo || i.id;
    let entry = map.get(key);
    if (!entry) {
      entry = { key, inc: i, units: [], startedAt: i.receivedAt, typedBy: i };
      map.set(key, entry);
    } else {
      entry.inc = fullerOf(entry.inc, i);
      if (i.receivedAt < entry.startedAt) entry.startedAt = i.receivedAt;
      if (isLaterType(entry.typedBy, i)) entry.typedBy = i;
    }
    for (const name of unitTokens(i.unit)) {
      if (!name) continue;
      const held = entry.units.find((u) => u.name === name);
      if (held) {
        held.stopped ||= i.stoppedAt != null;
        // A resource paged more than once joined on the earliest of them, and
        // rows arrive here newest first, so this walks the stamp backwards.
        if (i.receivedAt < held.joinedAt) {
          held.joinedAt = i.receivedAt;
          held.seq = seq;
        } else if (i.receivedAt === held.joinedAt && seq < held.seq) {
          held.seq = seq;
        }
      } else {
        entry.units.push({ name, stopped: i.stoppedAt != null, joinedAt: i.receivedAt, seq });
      }
    }
  }
  return [...map.values()].map(({ key, inc, units, startedAt, typedBy }) => ({
    key,
    inc:
      inc.receivedAt === startedAt && inc.type === typedBy.type
        ? inc
        : { ...inc, receivedAt: startedAt, type: typedBy.type },
    units: units
      .sort((a, b) =>
        a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : a.seq - b.seq,
      )
      .map(({ name, stopped }) => ({ name, stopped })),
  }));
}
