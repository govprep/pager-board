// BOM NSW Fire Danger Ratings (product IDN10026) — parse the registered-user
// HTML into the issued line, the seven forecast day names, and one row per
// district (and sub-area). A separate daily job hands the parsed digest to an
// LLM for a three-line summary and pushes it to every device — see
// scripts/fire-ratings.ts.

const WEEKDAYS = new Set([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

export interface DistrictRow {
  /** The place name, arrow marker stripped: "Far North Coast", "Clarence Valley". */
  district: string;
  /** True for a top-level NSW fire weather district (marked "↓"), false for a sub-area. */
  isDistrict: boolean;
  /** Band + Fire Behaviour Index per forecast day, aligned to `days`: "MOD 16". */
  ratings: string[];
}

export interface FireRatings {
  /** The "Issued at …" line — the dedupe key that decides whether to push. */
  issued: string;
  /** The seven forecast day names, in column order (first is tomorrow). */
  days: string[];
  rows: DistrictRow[];
}

/** Collapse &nbsp; and runs of whitespace to single spaces, then trim. */
function clean(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The statewide picture as compact text for the summariser: the issued line,
 * the day columns, then every district with its sub-areas (indented beneath
 * it), each carrying its band + Fire Behaviour Index per day. Sub-areas are
 * included so the highest rating can be pinned to a specific place, not only
 * its district. The first day column is tomorrow, which is what the model
 * headlines.
 */
export function toPrompt(ratings: FireRatings): string {
  const lines: string[] = [ratings.issued, "", `Days: ${ratings.days.join(", ")}`, ""];
  for (const row of ratings.rows) {
    const cells = row.ratings.map((r, i) => `${ratings.days[i] ?? `Day ${i + 1}`} ${r}`);
    const prefix = row.isDistrict ? "" : "  ";
    lines.push(`${prefix}${row.district}: ${cells.join(", ")}`);
  }
  return lines.join("\n");
}

// The house voice for the push. Terse, factual, three lines — matching how the
// board already talks. Band glossary is spelled out because the prompt carries
// BOM's abbreviations, not the words.
const SYSTEM_PROMPT = `You write a three-line fire danger analysis for NSW volunteer firefighters, from the Bureau of Meteorology's daily Fire Danger Ratings.

The prompt is a table: the "Issued at" line, the seven forecast day names (the FIRST is TOMORROW), then each fire weather district with its sub-areas indented beneath it. Each cell is a band code and its Fire Behaviour Index (FBI) number; a higher FBI is worse.

Band codes map to words — always write the WORD, in CAPITALS: NoR = NO RATING, MOD = MODERATE, HI = HIGH, EX = EXTREME, CAT = CATASTROPHIC.

Voice: terse, factual, plain text. No emoji, no markdown, no preamble, no lede. Every rating word is CAPITALISED. Output exactly three lines and nothing else:

Line 1 — tomorrow's overall picture, and it must say "tomorrow": the band most of the state sits in tomorrow. e.g. "Widespread MODERATE fire danger tomorrow." If it is genuinely split, say so briefly.
Line 2 — the single highest rating anywhere in the seven-day outlook: its CAPITALISED band, its FBI number, and the place — name the sub-area if the peak is a sub-area, otherwise the district; add the day if it is not tomorrow. e.g. "Highest rating is HIGH 27 for Northern Slopes on Thursday."
Line 3 — the outlook for the remaining days: if nothing else is elevated, "Nothing significant for the next N days." where N is the number of forecast days after tomorrow. Otherwise name the next elevated day and place.`;

export interface SummariseOpts {
  apiKey: string;
  /** Gemini model id; defaults to a free-tier flash model. */
  model?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Ask Gemini for the three-line summary of the prompt text. Returns at most
 * three trimmed lines; throws on a non-OK response or an empty completion so
 * the caller can skip the push rather than send an empty one.
 */
export async function summarise(prompt: string, opts: SummariseOpts): Promise<string> {
  const model = opts.model || "gemini-2.5-flash";
  const doFetch = opts.fetchImpl ?? fetch;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${encodeURIComponent(opts.apiKey)}`;

  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      // gemini-2.5-flash runs an internal reasoning pass that spends output
      // tokens. It's worth keeping — with it off the model puts an elevated
      // rating on the wrong day — but the budget has to clear it, or the answer
      // is truncated to just the lede. So thinking stays on (default) with a
      // budget far above what the reasoning pass needs. It's two calls a day.
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Gemini summary failed: ${res.status}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = await res.json();
  const text: string = body?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(0, 3);
  if (lines.length === 0) throw new Error("Gemini summary was empty");
  return lines.join("\n");
}

// The registered-user Fire Danger Ratings page. Same reg.bom.gov.au account as
// the FBI feed (see lib/fbi.ts) — HTTP Basic Auth, BOM_USER/BOM_PASS.
const IDN10026_URL = "https://reg.bom.gov.au/fwo/reg/IDN10026.html";

/**
 * Fetch and parse the current NSW Fire Danger Ratings. Throws when BOM
 * credentials are absent (a misconfiguration the caller should surface, not
 * silently skip) or when BOM answers with a non-OK status. `fetchImpl` is
 * injectable for tests.
 */
export async function fetchFireRatings(fetchImpl: typeof fetch = fetch): Promise<FireRatings> {
  const user = process.env.BOM_USER;
  const pass = process.env.BOM_PASS;
  if (!user || !pass) throw new Error("BOM_USER/BOM_PASS not set");

  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetchImpl(IDN10026_URL, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`BOM fire ratings fetch failed: ${res.status}`);
  return parseFireRatings(await res.text());
}

// Ratings older than this when we fetch them are treated as stale and never
// sent — a guard against a cron misfire or BOM serving a cached page. BOM issues
// the PM ratings ~4:15pm and the job runs ~4:20/4:30, so a live issue is minutes
// old; an hour is comfortably past that without being twitchy.
export const MAX_ISSUE_AGE_MS = 60 * 60_000;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

// BOM stamps the eastern-states abbreviation on the line, so daylight saving is
// explicit rather than inferred: EST/AEST is +10, EDT/AEDT is +11.
const TZ_OFFSET_HOURS: Record<string, number> = { est: 10, aest: 10, edt: 11, aedt: 11 };

/**
 * The "Issued at …" line as an absolute instant, or null if it can't be read.
 * BOM's format is "Issued at 4:15 pm EST on Tuesday 8 September 2026"; the
 * timezone token on the line fixes the offset, so this doesn't guess at DST.
 */
export function parseIssuedAt(issued: string): Date | null {
  const m = issued.match(
    /(\d{1,2}):(\d{2})\s*(am|pm)\s+([a-z]+)\s+on\s+\w+\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})/i,
  );
  if (!m) return null;
  const [, hh, mm, ap, tz, day, monthName, year] = m;

  const offset = TZ_OFFSET_HOURS[tz.toLowerCase()];
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (offset === undefined || month === -1) return null;

  let hour = Number(hh) % 12;
  if (ap.toLowerCase() === "pm") hour += 12;

  // Local eastern time minus its offset gives UTC.
  const ms = Date.UTC(Number(year), month, Number(day), hour - offset, Number(mm));
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Whether the issue is recent enough to send — within `maxAgeMs` of `now`. An
 * unparseable issued line can't be shown fresh, so it returns false: the guard
 * fails closed rather than pushing ratings of unknown age.
 */
export function isRecentIssue(
  issued: string,
  now: number,
  maxAgeMs: number = MAX_ISSUE_AGE_MS,
): boolean {
  const at = parseIssuedAt(issued);
  if (!at) return false;
  const age = now - at.getTime();
  return age >= 0 && age <= maxAgeMs;
}

/**
 * Whether a freshly fetched issue should be pushed. The issued line is the
 * dedupe key: a blank one (parse miss) is never pushed, and an issue matching
 * the last one already sent is a no-op — which is what lets the 16:20 and 16:30
 * cron runs both fire safely, whichever first sees BOM's afternoon update.
 */
export function isFreshIssue(issued: string, lastIssued: string | null): boolean {
  if (!issued) return false;
  return issued !== lastIssued;
}

export function parseFireRatings(html: string): FireRatings {
  const issuedMatch = html.match(/Issued at[^<]*/i);
  const issued = issuedMatch ? clean(issuedMatch[0]).replace(/\.$/, "") : "";

  const days: string[] = [];
  for (const m of html.matchAll(/<th[^>]*>\s*([A-Za-z]+)/g)) {
    const name = m[1];
    if (WEEKDAYS.has(name) && days.length < 7) days.push(name);
  }

  const rows: DistrictRow[] = [];
  for (const block of html.split(/<tr\b/i).slice(1)) {
    // The name cell is the 20%-wide left column; sub-areas share the same cell,
    // differing only in that a top-level district carries the "↓" marker.
    const nameMatch = block.match(/<td[^>]*width="20%"[^>]*>([^<]*)/i);
    if (!nameMatch) continue;
    const raw = nameMatch[1];
    const isDistrict = raw.includes("↓");
    const district = clean(raw.replace(/↓/g, ""));
    if (!district) continue;

    // Rating cells are the centre-aligned columns. Keying off the cell colour
    // instead would miss the No-Rating districts, whose white cells use an
    // rgb(…) value where the coloured bands use a #hex one — the name cell is
    // left-aligned, so it never matches.
    const ratings: string[] = [];
    for (const m of block.matchAll(/<td[^>]*text-align:\s*center[^>]*>([^<]*)/gi)) {
      const v = clean(m[1]);
      if (v) ratings.push(v);
    }
    if (ratings.length === 0) continue;

    rows.push({ district, isDistrict, ratings });
  }

  return { issued, days, rows };
}
