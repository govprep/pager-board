import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parsePagerMessage, hasIncidentNumber } from "../lib/parser";
import { standDownIncidentNo } from "../lib/standdown";
import { passesBoardFilter } from "../lib/filter";
import { recordRawMessages } from "../lib/raw-feed";
import { lgaKeyFromLocation } from "../lib/lga";
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

/** A row as it goes to `incidents`. */
interface IncidentRow {
  id: string;
  location: string;
  coords: Incident["coords"];
  [k: string]: unknown;
}

/**
 * Is `incoming` a poorer record of the same page than what's already stored?
 *
 * Two losses matter, because both are load-bearing rather than cosmetic:
 * coordinates (the map pin and the Slack static map) and the LGA (what a device
 * that has narrowed to an area matches on). A copy that would surrender either
 * is dropped whole rather than merged field-by-field — mixing them would pair
 * one source's address with another's `raw`, and a row that no longer matches
 * its own text is harder to trust than a slightly stale one.
 *
 * Anything else — a longer type string, different capitalisation — is allowed
 * through as before. This is a floor, not a preference ordering.
 */
function isWeakerThan(incoming: IncidentRow, stored: { location: string | null; coords: unknown }): boolean {
  const losesCoords = stored.coords != null && incoming.coords == null;
  const losesLga =
    lgaKeyFromLocation(stored.location ?? "") !== "" &&
    lgaKeyFromLocation(incoming.location ?? "") === "";
  return losesCoords || losesLga;
}

/**
 * Filter a batch down to the rows worth writing, comparing each against what's
 * already stored under the same id. Best-effort: if the lookup fails we write
 * the batch unchanged rather than stall ingestion on it.
 */
async function dropWeakerThanStored(
  db: SupabaseClient,
  rows: IncidentRow[],
  source: string,
): Promise<IncidentRow[]> {
  const ids = rows.map((r) => r.id);
  const stored = new Map<string, { location: string | null; coords: unknown }>();

  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db
      .from("incidents")
      .select("id, location, coords")
      .in("id", ids.slice(i, i + 200));
    if (error) {
      console.error(`[${source}] compare stored:`, error.message);
      return rows;
    }
    for (const r of data ?? []) stored.set(r.id, { location: r.location, coords: r.coords });
  }

  const kept: IncidentRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    const prior = stored.get(row.id);
    if (prior && isWeakerThan(row, prior)) dropped++;
    else kept.push(row);
  }
  if (dropped) console.log(`[${source}] kept ${dropped} stored row(s) over a thinner copy`);
  return kept;
}

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

  const db: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  });

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

    // Record the unfiltered stream FIRST — /raw shows everything that came over
    // the air, including the lines the board deliberately throws away. Sources
    // hand us their traffic unfiltered; the board filter runs below, after this.
    await recordRawMessages(db, lines, source);

    // Board filter. Until now this lived in each source; it sits here so the
    // raw feed above sees the traffic the board rejects. A line earns a look
    // from the parser only if it's structurally sound or is a stand-down.
    lines = lines.filter((l) => l.boardEligible !== false && passesBoardFilter(l.raw));
    if (!lines.length) return;

    // Stand-down notices (STOP/STAND DOWN/NNTA) flag an existing incident
    // rather than being parsed as a page of their own — pull them out first so
    // they never reach parsePagerMessage (which would otherwise read "STOP" as
    // a real TYPE/location update and clobber the incident it refers to on
    // upsert).
    const standDownNos = new Set<string>();
    const normalLines: PagerLine[] = [];
    for (const line of lines) {
      const no = standDownIncidentNo(line.raw);
      if (no) standDownNos.add(no);
      else normalLines.push(line);
    }
    if (standDownNos.size) {
      const { error } = await db
        .from("incidents")
        .update({ stopped_at: new Date().toISOString() })
        .in("incident_no", [...standDownNos]);
      if (error) console.error(`[${source}] stand-down update:`, error.message);
      else console.log(`[${source}] stood down ${standDownNos.size} incident(s)`);
    }
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

    // Collapse duplicate ids within the batch, preferring the copy that carried
    // a real timestamp so a time-less duplicate never clobbers a good one.
    const byId = new Map<string, (typeof parsed)[number]>();
    for (const p of parsed) {
      const existing = byId.get(p.inc.id);
      if (!existing || (!existing.hasTime && p.hasTime)) byId.set(p.inc.id, p);
    }

    const unique = [...byId.values()].map(({ inc }) => ({
      id: inc.id,
      incident_no: inc.incidentNo,
      type: inc.type,
      unit: inc.unit,
      location: inc.location,
      coords: inc.coords,
      fields: inc.fields,
      received_at: inc.receivedAt,
      raw: inc.raw,
    }));

    // Don't let a thinner copy of a page overwrite a fuller one already stored.
    //
    // Sources disagree on how much of a page they carry — pager-feed.net, for
    // one, truncates the address at the suburb and drops the coordinates — and
    // because a row is keyed on {incidentNo}-{unit}, every source reporting the
    // same page writes to the same row. Without this, the board shows whichever
    // copy happened to arrive last: a job could lose its map pin, and lose its
    // LGA, which is what area-narrowed devices match on.
    const kept = await dropWeakerThanStored(db, unique, source);
    if (!kept.length) return;

    const { data, error } = await db
      .from("incidents")
      .upsert(kept, { onConflict: "id" })
      .select("id");

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
