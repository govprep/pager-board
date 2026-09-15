import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Stand-downs (STOP / STAND DOWN / NNTA).
//
// A stand-down is not a page of its own — it cancels a turnout that is already
// on the board, and usually cancels it for ONE brigade rather than for the whole
// job. Control routinely stands down some resources while the rest keep working,
// so the board records `stopped_at` per row (a row is one {incident, unit}) and
// colours that resource, instead of flagging the incident.
//
// The lines arrive in every arrangement the feeds can manage. Real examples:
//
//   LHBENWE9 - 26-123547 - Bush Fire - ... - STOP MESSAGE - NNTA THANK YOU
//   STOP MESSAGE - LHBENWE9 - 26-123547 - Bush Fire - RHONDDA ROAD, TERALBA
//   STOP///CMMIDDL1 - 26-123389 - Backyard fire - FIRECALL - RAMSAY RD,...
//   12:33:09 STOP MESSAGE//CMERSPA - 26-123386 - Unknown fire - FIRECALL - ...
//   26-123495 LHRAYTE7 Stop Message // NINE MILE CREEK RD ... - STOP ON INC
//   STOP MESSAGE - STOP FROM TMC - RFS NOT REQ - CCDO - 26-123527 - Tree Down
//   22:48:39 STOP MESSAGE - 26-123339 - MVA - 678-686 RICHMOND RD,...
//
// The brigade sits in a different slot in every one of them, so reading it by
// position is hopeless. Instead the line is reduced to a bag of tokens, and the
// brigade is whichever of the incident's ALREADY-STORED units the line mentions
// — see unitsNamedBy(). That needs no guess about what a brigade code looks
// like, and it cannot invent a unit the job never had. The last example names
// none of them, and correctly stands the whole incident down.
//
// Some stop templates, though, name nobody at all:
//
//   12:49:52 26-127771 - Bush Fire - FIRECALL - GEORGES RIVER RD,... - STOP MESSAGE - NNTA
//
// which stood twelve resources down off one page that was only ever sent to
// one of them. A page is addressed to a capcode, and a capcode is a brigade's
// pager, so the brigade IS known — just not in the text. The sources report it
// alongside the line as the origin ("(Cumberland) - Comms Brigade"), and the
// same origin sits on the turnout page that brigade got for the same job, which
// does carry its unit. So an unnamed stand-down is attributed by matching its
// origin against the incident's own turnout pages — see unitsPagedFrom().
//
// That only helps when the origin singles somebody out. A district Duty Officer
// capcode gets a copy of every brigade's page, so its origin sits on all of
// them; "narrowing" to every row is no narrowing, and those fall through to the
// whole incident exactly as before.
// ---------------------------------------------------------------------------

/** STOP or NNTA as their own token (not STOPFORD/STOPPED), or "STAND DOWN". */
const STANDDOWN_RE = /\bSTAND\s*DOWN\b|\bNNTA\b|\bSTOP\b/i;

// RFS incident numbers are "YY-NNNNNN". Anchored, so a street range ("678-686")
// and a phone number ("0055-3745") don't read as one.
const RFS_INC_RE = /^\d{2}-\d{3,}$/;

export interface StandDown {
  /** The incident the line cancels. */
  incidentNo: string;
  /** Every alphanumeric token in the line, uppercased — the bag matched against. */
  tokens: Set<string>;
  /**
   * The brigade pager(s) this line arrived on, as the source named them. A set
   * because the same notice reaches us from several sources, each with its own
   * spelling ("(Macarthur) - Appin" / "APPIN"), and because one copy of a line
   * can be addressed to more than one brigade. Empty when no source said.
   */
  origins: Set<string>;
}

/** Uppercased alphanumeric tokens; dashes kept so "26-123547" stays whole. */
function tokenise(line: string): string[] {
  return line.toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean);
}

/**
 * Read a stand-down line, or null if it isn't one (or names no incident we
 * could act on — plain noise like "STOP MESSAGE NO NEED TO ATTEND THANK YOU").
 */
export function parseStandDown(raw: string, origin?: string | null): StandDown | null {
  const line = (raw ?? "").trim();
  if (!line || !STANDDOWN_RE.test(line)) return null;

  const tokens = tokenise(line);

  // FRNSW carries the number under a key ("INC: 120047-14062026" — number and
  // date); RFS carries it as a bare token. Reading the key first keeps a bare
  // turnout number from being mistaken for the incident.
  const keyed = line.match(/\bINC\s*:\s*(\S+)/i)?.[1] ?? "";
  const fromKey = keyed.split("-")[0].trim();

  const incidentNo =
    (/^\d+$/.test(fromKey) ? fromKey : "") ||
    tokens.find((t) => RFS_INC_RE.test(t)) ||
    "";

  if (!incidentNo) return null;
  return { incidentNo, tokens: new Set(tokens), origins: originSet(origin) };
}

/** A reported origin as a one-element set, dropping blanks and placeholders. */
function originSet(origin?: string | null): Set<string> {
  const o = (origin ?? "").trim();
  return new Set(!o || o === "-" || o === "—" ? [] : [o]);
}

/**
 * Fold a second copy of the same notice into the first, keeping both origins.
 * The same stop reaches us from several sources and can be addressed to several
 * brigades; callers dedupe on the line's text, which would otherwise keep one
 * arbitrary origin and lose the rest.
 */
export function mergeStandDown(into: StandDown, from: StandDown): StandDown {
  for (const o of from.origins) into.origins.add(o);
  return into;
}

/**
 * If `raw` is a stand-down notice, the incident number it refers to. Kept for
 * the board filter and the raw feed's classifier, which only need to know that
 * the line is a stand-down and which job it belongs to.
 */
export function standDownIncidentNo(raw: string): string | null {
  return parseStandDown(raw)?.incidentNo ?? null;
}

/**
 * Which of `units` the line names. A unit is matched on its leading token, which
 * is the brigade code for RFS ("LHBENWE9") and the turnout number for FRNSW
 * ("428 QUEANBEYAN" -> "428"). Heads shorter than three characters are ignored:
 * a two-digit turnout is too easy to hit by accident, and falling back to the
 * whole incident is the safer miss.
 */
export function unitsNamedBy(sd: StandDown, units: string[]): string[] {
  return units.filter((u) => namedIn(sd.tokens, u));
}

/** Whether a bag of tokens names `unit` by its leading token. */
function namedIn(tokens: Set<string>, unit: string): boolean {
  const head = (unit ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  return head.length >= 3 && tokens.has(head);
}

/**
 * Which of `units` were paged from the same brigade the stand-down reached.
 *
 * `turnouts` are the incident's own earlier pages, each with the origin the
 * source reported for it. A turnout page leads with its unit, so tokenising it
 * and applying the same head-token rule maps origin -> unit without needing to
 * know what a brigade code looks like — and without inventing a unit the job
 * never had, since the answer is drawn from `units`.
 */
export function unitsPagedFrom(
  sd: StandDown,
  units: string[],
  turnouts: { origin: string | null; raw: string }[],
): string[] {
  if (!sd.origins.size) return [];
  const bags = turnouts
    .filter((t) => t.origin && sd.origins.has(t.origin))
    .map((t) => new Set(tokenise(t.raw)));
  if (!bags.length) return [];
  return units.filter((u) => bags.some((b) => namedIn(b, u)));
}

/**
 * The turnout pages recorded for these jobs, limited to the origins the
 * stand-downs arrived on — the pages that can say which unit a brigade is.
 *
 * Reads `pager_messages` (the raw feed), which is where origin is kept;
 * `incidents` has never stored it. Best-effort: on failure the callers simply
 * find nothing to attribute and fall back to the whole incident.
 */
async function turnoutOrigins(
  db: SupabaseClient,
  standDowns: StandDown[],
  source: string,
): Promise<Map<string, { origin: string | null; raw: string }[]>> {
  const byIncident = new Map<string, { origin: string | null; raw: string }[]>();
  if (!standDowns.length) return byIncident;

  const numbers = [...new Set(standDowns.map((sd) => sd.incidentNo))];
  const origins = [...new Set(standDowns.flatMap((sd) => [...sd.origins]))];

  for (let offset = 0; offset < numbers.length; offset += 200) {
    const { data, error } = await db.from("pager_messages")
      .select("incident_no, origin, raw")
      .eq("status", "incident")
      .in("incident_no", numbers.slice(offset, offset + 200))
      .in("origin", origins);
    if (error) {
      console.error(`[${source}] stand-down origin lookup:`, error.message);
      continue;
    }
    for (const row of data ?? []) {
      const rows = byIncident.get(row.incident_no) ?? [];
      rows.push({ origin: row.origin, raw: row.raw });
      byIncident.set(row.incident_no, rows);
    }
  }
  return byIncident;
}

/**
 * Stamp `stopped_at` on the rows each stand-down cancels, in order of how
 * directly the evidence names them:
 *
 *   1. the brigades the line's own text names;
 *   2. failing that, the brigade whose pager the line arrived on, matched to a
 *      unit through that brigade's turnout page for the same job;
 *   3. failing that, the whole incident.
 *
 * Best-effort — a stand-down that can't be applied is logged and skipped rather
 * than failing the batch it arrived in.
 */
export async function applyStandDowns(
  db: SupabaseClient,
  standDowns: StandDown[],
  source: string,
): Promise<void> {
  if (!standDowns.length) return;
  const stoppedAt = new Date().toISOString();
  let units = 0;
  let whole = 0;

  const byIncident = new Map<string, { id: string; unit: string }[]>();
  const numbers = [...new Set(standDowns.map((sd) => sd.incidentNo))];
  for (let offset = 0; offset < numbers.length; offset += 200) {
    const { data, error } = await db.from("incidents")
      .select("id, unit, incident_no").in("incident_no", numbers.slice(offset, offset + 200));
    if (error) {
      console.error(`[${source}] stand-down lookup:`, error.message);
      continue;
    }
    for (const row of data ?? []) {
      const rows = byIncident.get(row.incident_no) ?? [];
      rows.push(row);
      byIncident.set(row.incident_no, rows);
    }
  }

  // Turnout pages for the jobs whose stand-downs named nobody, fetched only for
  // the origins those stand-downs arrived on. Usually nothing to do: all but a
  // handful of notices name their brigade outright, and this is a round trip.
  const unnamed = standDowns.filter((sd) => {
    const rows = byIncident.get(sd.incidentNo) ?? [];
    return rows.length > 0 && sd.origins.size > 0
      && !rows.some((r) => unitsNamedBy(sd, [r.unit ?? ""]).length > 0);
  });
  const turnouts = await turnoutOrigins(db, unnamed, source);

  for (const sd of standDowns) {
    const rows = byIncident.get(sd.incidentNo) ?? [];
    if (!rows.length) continue; // cancels a job we never saw

    const named = rows.filter((r) => unitsNamedBy(sd, [r.unit ?? ""]).length > 0);

    // The line named nobody: fall back to the pager it reached. Only counts if
    // it singles somebody out — an origin that covers every row (a district
    // Duty Officer's capcode) has told us nothing, so let it blanket the job.
    let paged: typeof rows = [];
    if (!named.length) {
      const units = unitsPagedFrom(sd, rows.map((r) => r.unit ?? ""),
        turnouts.get(sd.incidentNo) ?? []);
      if (units.length && units.length < rows.length) {
        paged = rows.filter((r) => units.includes(r.unit ?? ""));
      }
    }

    const targets = named.length ? named : paged.length ? paged : rows;
    if (targets === rows && rows.length > 1) {
      console.warn(
        `[${source}] stand-down on ${sd.incidentNo} names no brigade we hold` +
          `${sd.origins.size ? "" : " and arrived without an origin"}` +
          ` — standing down all ${rows.length} resources`,
      );
    }

    const { error: updateError } = await db
      .from("incidents")
      .update({ stopped_at: stoppedAt })
      .in("id", targets.map((r) => r.id));
    if (updateError) {
      console.error(`[${source}] stand-down update:`, updateError.message);
    } else if (targets !== rows) units += targets.length;
    else whole++;
  }

  if (units || whole) {
    console.log(
      `[${source}] stood down ${units} resource(s)` +
        (whole ? ` and ${whole} whole incident(s)` : ""),
    );
  }
}
