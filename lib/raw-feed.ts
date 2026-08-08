import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parsePagerMessage, hasIncidentNumber } from "./parser";
import { standDownIncidentNo } from "./standdown";
import { isValidPagerLine } from "./filter";
import type { RawStatus } from "./types";

// ---------------------------------------------------------------------------
// The raw feed: every line every source sees, before any board filtering.
//
// The board (`incidents`) is a heavily filtered view — SES traffic, decode
// noise, test pages, stand-downs and number-less pages never land there. This
// module records the unfiltered stream into `pager_messages` so /raw can show
// what actually came over the air, tagged with what the pipeline did with it.
//
// Identical lines collapse into one row. The dedup key is a sha256 of the
// whitespace-normalised text, which is what makes cross-source dedup work: the
// same page arriving from pocsag, telegram and rfspager (each with its own
// spacing quirks) is one row listing all three sources.
//
// NOTE: `normalizeRaw` and `rawHash` have a matching SQL implementation in
// supabase/schema.sql (used to backfill from incidents.raw). Change one and you
// must change the other, or old rows stop deduping against new ones.
// ---------------------------------------------------------------------------

/** Collapse whitespace runs and trim — the canonical form used for dedup. */
export function normalizeRaw(raw: string): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/** Dedup key for a raw line. */
export function rawHash(raw: string): string {
  return createHash("sha256").update(normalizeRaw(raw), "utf8").digest("hex");
}

/**
 * What the pipeline does with this line, and the incident number it refers to
 * (when it has one). Mirrors the ingest logic in feeder/poster.ts exactly:
 * stand-downs are pulled out first, then the board filter, then the parser.
 *
 * `boardEligible: false` marks a line the source knows can never reach the
 * board (an rfspager row with no parseable time) — it's still recorded, just
 * always as dropped.
 */
export function classifyLine(
  raw: string,
  boardEligible = true,
): { status: RawStatus; incidentNo: string | null } {
  const standDown = standDownIncidentNo(raw);
  if (standDown) {
    return { status: boardEligible ? "standdown" : "dropped", incidentNo: standDown };
  }

  const inc = isValidPagerLine(raw) ? parsePagerMessage(raw) : null;
  if (inc && hasIncidentNumber(inc)) {
    return {
      status: boardEligible ? "incident" : "dropped",
      incidentNo: inc.incidentNo.trim(),
    };
  }
  return { status: "dropped", incidentNo: null };
}

export interface RawEntry {
  raw: string;
  /** The message's own time. Falls back to now() when the source has none. */
  receivedAt?: string;
  /** False when the source already knows this line can't reach the board. */
  boardEligible?: boolean;
}

/**
 * Record lines into `pager_messages`, deduplicating by content hash. Repeats
 * bump `seen_count` / `last_seen_at` and merge the source into `sources`
 * rather than creating a second row — see the record_pager_messages() function
 * in supabase/schema.sql.
 *
 * Best-effort: the raw feed is an observability surface, so a failure here logs
 * and returns instead of breaking ingestion of actual incidents.
 */
export async function recordRawMessages(
  db: SupabaseClient,
  entries: RawEntry[],
  source: string,
): Promise<void> {
  const payload = entries
    .filter((e) => normalizeRaw(e.raw) !== "")
    .map((e) => {
      const { status, incidentNo } = classifyLine(e.raw, e.boardEligible !== false);
      return {
        hash: rawHash(e.raw),
        raw: normalizeRaw(e.raw),
        status,
        incident_no: incidentNo,
        source,
        received_at: e.receivedAt ?? new Date().toISOString(),
      };
    });

  if (!payload.length) return;

  const { error } = await db.rpc("record_pager_messages", { payload });
  if (error) console.error(`[${source}] raw feed:`, error.message);
}
