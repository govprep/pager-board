import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "../lib/supabase-server";
import { parsePagerMessage, hasIncidentNumber } from "../lib/parser";
import { parseStandDown, applyStandDowns, type StandDown } from "../lib/standdown";
import { passesBoardFilter } from "../lib/filter";
import { recordRawMessages } from "../lib/raw-feed";
import { collapseById, dropWeakerThanStored, type IncidentRow } from "../lib/incident-merge";
import { attachFireWeather } from "../lib/fbi";
import { makeMutex } from "../lib/mutex";
import type { Incident } from "../lib/types";
import { postPending } from "./slack";
import { pushPending } from "./push";

export interface PagerLine {
  raw: string;
  receivedAt?: string; // ISO string — defaults to now() if omitted
  /**
   * Where the page came from, when the source tells us. rfspager.app has
   * Capcode/Agency/Brigade columns and PagerMon returns address/agency/alias —
   * the same three fields under different names. Shown on /raw; for rows that
   * lack them, lib/origin.ts recovers what it can from the line's own text.
   */
  capcode?: string | null;
  agency?: string | null;
  origin?: string | null;
  /**
   * False when the source already knows this line can't become a board row —
   * currently only an rfspager row with no parseable time, which would scramble
   * the board's ordering. Such lines are still recorded in the raw feed.
   * Defaults to true.
   */
  boardEligible?: boolean;
}

export type PostFn = (lines: PagerLine[], source: string) => Promise<void>;

export interface Writer {
  post: PostFn;
  clear: () => Promise<void>;
}

export function makeWriter(): Writer {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }

  const db: SupabaseClient = createServerClient(url, key);

  // All sources share one writer, so this serialises the compare-then-upsert
  // across every one of them. See lib/mutex.ts for why that matters.
  const serialize = makeMutex();

  // Wipes the board only. `pager_messages` is an append-only record of what came
  // over the air, so a board reset deliberately leaves it intact.
  async function clear() {
    const { error } = await db.from("incidents").delete().neq("id", "");
    if (error) throw new Error(error.message);
    // Drop thread mappings too, so a re-ingest starts fresh parent messages
    // instead of replying into now-orphaned Slack threads.
    await db.from("incident_threads").delete().neq("incident_no", "");
  }

  async function write(lines: PagerLine[], source: string) {
    if (!lines.length) return;

    // Record the unfiltered stream — /raw shows everything that came over the
    // air, including the lines the board deliberately throws away. Sources hand
    // us their traffic unfiltered; the board filter runs below.
    //
    // Started here but NOT awaited until the board row is written. `incidents`
    // and `pager_messages` share no keys and nothing below reads the raw feed
    // back, so the ordering was never load-bearing — but every Supabase round
    // trip from this host costs ~200ms, and awaiting this one first put the raw
    // feed's write in front of the board's on every single page. Measured
    // end-to-end, the fastest source (pager-feed) delivers in ~1.0s, of which
    // roughly four sequential round trips are ours; this is one of them.
    //
    // It stays best-effort either way: the raw feed is an observability
    // surface, so a failure here is logged, not thrown.
    const rawWrite = recordRawMessages(db, lines, source).catch((err) =>
      console.error(`[${source}] raw feed:`, err instanceof Error ? err.message : err),
    );

    // The board path runs alongside it; the raw write is still settled before
    // we return, so a batch never leaves a write dangling behind it.
    try {
      await writeBoard(lines, source);
    } finally {
      await rawWrite;
    }
  }

  async function writeBoard(lines: PagerLine[], source: string) {
    // Board filter. Until now this lived in each source; it sits here so the
    // raw feed above sees the traffic the board rejects. A line earns a look
    // from the parser only if it's structurally sound or is a stand-down.
    lines = lines.filter((l) => l.boardEligible !== false && passesBoardFilter(l.raw));
    if (!lines.length) return;

    // Stand-down notices (STOP/STAND DOWN/NNTA) cancel resources on an existing
    // incident rather than being parsed as a page of their own — pull them out
    // first so they never reach parsePagerMessage (which would otherwise read
    // "STOP" as a real TYPE/location update and clobber the incident it refers
    // to on upsert). Deduplicated by line, since the same notice reaches several
    // sources; two notices naming different brigades are both kept.
    const standDowns = new Map<string, StandDown>();
    const normalLines: PagerLine[] = [];
    for (const line of lines) {
      const sd = parseStandDown(line.raw);
      if (sd) standDowns.set(line.raw.replace(/\s+/g, " ").trim(), sd);
      else normalLines.push(line);
    }
    await applyStandDowns(db, [...standDowns.values()], source);

    lines = normalLines;
    if (!lines.length) return;

    // Track whether each line carried an explicit time. parsePagerMessage fills
    // a now() default when it didn't, so we can't tell from received_at alone.
    const parsed = lines
      .map(({ raw, receivedAt }) => {
        const inc = parsePagerMessage(raw, receivedAt);
        return inc ? { inc, hasTime: receivedAt != null } : null;
      })
      // Only numbered incidents (RFS + FRNSW) are stored/mirrored — SES and
      // number-less pages are dropped at ingestion.
      .filter((p): p is { inc: Incident; hasTime: boolean } =>
        p !== null && hasIncidentNumber(p.inc));

    if (!parsed.length) return;

    // Collapse duplicate ids within the batch, keeping the fullest copy — a
    // batch can carry both a complete page and a truncated decode of it.
    const unique = collapseById(
      parsed.map(({ inc, hasTime }) => ({
        hasTime,
        row: {
          id: inc.id,
          incident_no: inc.incidentNo,
          type: inc.type,
          unit: inc.unit,
          location: inc.location,
          coords: inc.coords,
          fields: inc.fields,
          received_at: inc.receivedAt,
          raw: inc.raw,
        } satisfies IncidentRow,
      })),
    ).map(({ row }) => row);

    // Nearest station's Fire Behaviour Index, for the RFS calls it applies to.
    const withFireWeather = await attachFireWeather(db, unique);

    // Then the same comparison against what's already on the board, so a thinner
    // copy of a page can't overwrite a fuller one that landed earlier. Held
    // together with the upsert so a concurrent source can't slip between them.
    const { data, error } = await serialize(async () => {
      const kept = await dropWeakerThanStored(db, withFireWeather, source);
      if (!kept.length) return { data: null, error: null };
      return db.from("incidents").upsert(kept, { onConflict: "id" }).select("id");
    });

    if (error) {
      console.error(`[${source}] supabase:`, error.message);
      return;
    }

    const count = data?.length ?? 0;
    if (count) console.log(`[${source}] +${count} incident(s)`);

    // Mirror to Slack (no-op unless SLACK_BOT_TOKEN is set) and fan out phone
    // push (no-op unless VAPID keys are set). Both self-filter to pages not yet
    // sent, so re-upserts of unchanged rows cost nothing.
    if (count) {
      const upsertedIds = data!.map((r) => r.id);
      await postPending(db, upsertedIds);
      await pushPending(db, upsertedIds);
    }
  }

  return { post: write, clear };
}
