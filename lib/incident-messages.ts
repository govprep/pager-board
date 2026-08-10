import type { PagerMessage } from "./types";

// ---------------------------------------------------------------------------
// The page history behind one incident, as shown on the board's incident card.
//
// `pager_messages` is already deduplicated: its primary key is a hash of the
// whitespace-normalised line, so one page arriving from three feeds is one row
// listing all three. Two things still slip past that, and both would fill the
// card with the same page over and over:
//
//   1. Punctuation. Feeds lay the same page out differently — bracketed coords
//      "[149.53,-34.4]" against bare "149.53,-34.4", en-dashes against hyphens.
//   2. The counter a positional page carries ahead of the station ("19 STDO",
//      "47 STDO", and "STDO" with none at all are all the same page to the same
//      station). It isn't the turnout: lib/parser.ts reads the station out of
//      the header and throws the number away, so the board already treats those
//      as one job for one station.
//
// On a real job this is the difference between 16 near-identical lines and the
// 3 distinct pages that actually went out.
// ---------------------------------------------------------------------------

/** Dedup key: what's left of a line after dropping both sources of noise. */
export function messageKey(raw: string): string {
  return raw
    .replace(/^\s*\d+\s+/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Collapse near-identical lines and order them oldest-first, so the card reads
 * as the job's timeline. A merged entry reports the earliest time any copy was
 * seen and pools their sources; where copies disagree on the metadata, the one
 * that actually has a value wins (rows backfilled from the board carry none).
 */
export function dedupeMessages(list: PagerMessage[]): PagerMessage[] {
  const byKey = new Map<string, PagerMessage>();

  for (const m of list) {
    const key = messageKey(m.raw);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...m, sources: [...m.sources] });
      continue;
    }

    seen.sources = [...new Set([...seen.sources, ...m.sources])];
    if (m.receivedAt < seen.receivedAt) seen.receivedAt = m.receivedAt;
    if (m.lastSeenAt > seen.lastSeenAt) seen.lastSeenAt = m.lastSeenAt;
    // Counts aren't added up: a polling feed re-reports its whole buffer, so
    // they already run into the hundreds for a single page, and summing across
    // merged copies would only inflate that further.
    seen.seenCount = Math.max(seen.seenCount, m.seenCount);
    seen.origin ??= m.origin;
    seen.agency ??= m.agency;
    seen.capcode ??= m.capcode;
    // Keep the fullest copy of the text — a truncated decode shouldn't win.
    if (m.raw.length > seen.raw.length) seen.raw = m.raw;
  }

  return [...byKey.values()].sort((a, b) =>
    a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
  );
}
