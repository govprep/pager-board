// Tests for the BOM NSW Fire Danger Ratings parser (product IDN10026).
//
// Run: npm test
//
// The fixture is a real IDN10026.html captured from reg.bom.gov.au — the same
// page the daily push summarises. Parsing has to survive BOM's exact markup:
// the "Issued at" line (our dedupe key), the seven day-name headers, and the
// district rows whose top-level fire weather districts are marked with a "↓".

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseFireRatings,
  toPrompt,
  summarise,
  isFreshIssue,
  fetchFireRatings,
  parseIssuedAt,
  isRecentIssue,
  MAX_ISSUE_AGE_MS,
} from "./fire-ratings";

const html = readFileSync(
  fileURLToPath(new URL("./fire-ratings.fixture.html", import.meta.url)),
  "utf8",
);

test("issued line is extracted, nbsp-normalised, without trailing dot", () => {
  const { issued } = parseFireRatings(html);
  assert.equal(issued, "Issued at 4:15 pm EST on Tuesday 8 September 2026");
});

test("the seven forecast day headers come through in order", () => {
  const { days } = parseFireRatings(html);
  assert.deepEqual(days, [
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
    "Monday",
    "Tuesday",
  ]);
});

test("top-level fire weather districts are flagged and carry seven ratings", () => {
  const { rows } = parseFireRatings(html);

  const far = rows.find((r) => r.district === "Far North Coast");
  assert.ok(far, "Far North Coast row should be parsed");
  assert.equal(far!.isDistrict, true);
  assert.equal(far!.ratings.length, 7);
  assert.equal(far!.ratings[0], "MOD 16");
  assert.equal(far!.ratings[1], "MOD 21");

  // The "↓" arrow is a marker, never part of the name.
  assert.ok(!far!.district.includes("↓"));
});

test("sub-areas are parsed but not flagged as districts", () => {
  const { rows } = parseFireRatings(html);
  const clarence = rows.find((r) => r.district === "Clarence Valley");
  assert.ok(clarence, "Clarence Valley (a sub-area) should be parsed");
  assert.equal(clarence!.isDistrict, false);
  assert.equal(clarence!.ratings.length, 7);
});

test("every top-level district parses with a full week of ratings", () => {
  const { rows } = parseFireRatings(html);
  const districts = rows.filter((r) => r.isDistrict);
  // The 20 NSW fire weather districts plus the ACT row BOM lists alongside them.
  assert.equal(districts.length, 21);
  // The No-Rating districts use rgb(...) cell colours instead of hex; a parser
  // that keys off the colour format drops their week to nothing.
  for (const d of districts) {
    assert.equal(d.ratings.length, 7, `${d.district} should have 7 ratings`);
  }
});

test("No-Rating and High districts keep their band tokens", () => {
  const { rows } = parseFireRatings(html);
  const nor = rows.find((r) => r.district === "Upper Central West Plains");
  assert.ok(nor, "a No-Rating district should be parsed");
  assert.equal(nor!.ratings[0], "NoR 11");

  const high = rows.find((r) => r.district === "Northern Slopes");
  assert.ok(high, "the district with a High day should be parsed");
  assert.ok(
    high!.ratings.some((r) => r.startsWith("HI")),
    "Northern Slopes has a HIGH day that must survive parsing",
  );
});

test("toPrompt lists districts and their sub-areas across the named days", () => {
  const ratings = parseFireRatings(html);
  const prompt = toPrompt(ratings);

  // The statewide picture: districts by name, and the day columns.
  assert.match(prompt, /Far North Coast/);
  assert.match(prompt, /Northern Slopes/);
  assert.match(prompt, /Wednesday/);
  assert.match(prompt, /Tuesday/);
  // The elevated day has to be visible for the model to headline it.
  assert.match(prompt, /HI 27/);
  // Sub-areas are included now too, so the highest rating can be pinned to a
  // specific place rather than only its district.
  assert.match(prompt, /Clarence Valley/);
  // Sub-areas are marked as subordinate to their district (indented), so the
  // model can tell a district headline from one council within it.
  assert.match(prompt, /^ +Clarence Valley:/m);
  // The issued line rides along so the model can anchor "tomorrow".
  assert.match(prompt, /Issued at 4:15 pm EST/);
});

// A Gemini generateContent response carrying the given text.
function geminiReply(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  } as Response;
}

test("summarise sends the prompt to Gemini and returns its three lines", async () => {
  let sentUrl = "";
  let sentBody = "";
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sentUrl = String(url);
    sentBody = String(init?.body ?? "");
    return geminiReply(
      "PM ratings are in.\nHIGH about the Northern Slopes tomorrow.\nEasing to Moderate after that.\n",
    );
  }) as unknown as typeof fetch;

  const out = await summarise("Northern Slopes: Thursday HI 27", {
    apiKey: "k",
    fetchImpl,
  });

  assert.equal(
    out,
    "PM ratings are in.\nHIGH about the Northern Slopes tomorrow.\nEasing to Moderate after that.",
  );
  // The ratings text has to actually reach the model.
  assert.match(sentBody, /Northern Slopes: Thursday HI 27/);
  // Key travels to the Gemini endpoint, not baked into the prompt.
  assert.match(sentUrl, /generativelanguage\.googleapis\.com/);
  assert.match(sentUrl, /key=k/);
});

test("summarise never returns more than three lines", async () => {
  const fetchImpl = (async () =>
    geminiReply("one\ntwo\nthree\nfour\nfive")) as unknown as typeof fetch;
  const out = await summarise("x", { apiKey: "k", fetchImpl });
  assert.equal(out.split("\n").length, 3);
});

test("summarise throws when Gemini answers with an error status", async () => {
  const fetchImpl = (async () =>
    ({ ok: false, status: 429, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  await assert.rejects(summarise("x", { apiKey: "k", fetchImpl }), /429/);
});

test("isFreshIssue pushes a new issue, and never re-pushes the same one", () => {
  const a = "Issued at 4:15 pm EST on Tuesday 8 September 2026";
  const b = "Issued at 4:15 pm EST on Wednesday 9 September 2026";
  // First sight of an issue: push.
  assert.equal(isFreshIssue(a, null), true);
  // The 16:30 run seeing the same issue the 16:20 run already sent: no-op.
  assert.equal(isFreshIssue(a, a), false);
  // A genuinely newer issue: push.
  assert.equal(isFreshIssue(b, a), true);
  // A blank issued line (a parse miss) is never pushed.
  assert.equal(isFreshIssue("", null), false);
});

test("fetchFireRatings sends BOM basic auth and parses the response", async () => {
  const prev = { u: process.env.BOM_USER, p: process.env.BOM_PASS };
  process.env.BOM_USER = "bomuser";
  process.env.BOM_PASS = "bompass";
  try {
    let sentAuth = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return { ok: true, status: 200, text: async () => html } as Response;
    }) as unknown as typeof fetch;

    const ratings = await fetchFireRatings(fetchImpl);
    assert.equal(sentAuth, `Basic ${Buffer.from("bomuser:bompass").toString("base64")}`);
    assert.equal(ratings.issued, "Issued at 4:15 pm EST on Tuesday 8 September 2026");
  } finally {
    process.env.BOM_USER = prev.u;
    process.env.BOM_PASS = prev.p;
  }
});

test("fetchFireRatings throws when BOM credentials are absent", async () => {
  const prev = { u: process.env.BOM_USER, p: process.env.BOM_PASS };
  delete process.env.BOM_USER;
  delete process.env.BOM_PASS;
  try {
    await assert.rejects(fetchFireRatings(), /BOM_USER/);
  } finally {
    process.env.BOM_USER = prev.u;
    process.env.BOM_PASS = prev.p;
  }
});

test("summarise leaves thinking on but gives it enough output budget", async () => {
  // gemini-2.5-flash spends output tokens on an internal reasoning pass. Too
  // small a budget and that pass starves the answer (only the lede returns);
  // turning thinking off avoids the starve but the model then misattributes the
  // day of an elevated rating. So thinking stays on with a generous budget.
  let sent: any;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return geminiReply("one\ntwo\nthree");
  }) as unknown as typeof fetch;

  await summarise("x", { apiKey: "k", fetchImpl });

  assert.notEqual(
    sent.generationConfig.thinkingConfig?.thinkingBudget,
    0,
    "thinking must not be disabled — it fixes the day mapping",
  );
  assert.ok(
    sent.generationConfig.maxOutputTokens >= 1024,
    "output budget must clear the thinking pass",
  );
});

test("parseIssuedAt reads the BOM issued line as a real instant (EST = AEST +10)", () => {
  const at = parseIssuedAt("Issued at 4:15 pm EST on Tuesday 8 September 2026");
  // 4:15 pm AEST on 8 Sep 2026 is 06:15 UTC.
  assert.equal(at?.toISOString(), "2026-09-08T06:15:00.000Z");
});

test("parseIssuedAt handles daylight time (EDT = AEDT +11) and returns null on junk", () => {
  const at = parseIssuedAt("Issued at 4:15 pm EDT on Sunday 1 February 2026");
  assert.equal(at?.toISOString(), "2026-02-01T05:15:00.000Z");
  assert.equal(parseIssuedAt("Issued at some point yesterday"), null);
  assert.equal(parseIssuedAt(""), null);
});

test("isRecentIssue sends only when the issue is within the last hour", () => {
  const issued = "Issued at 4:15 pm EST on Tuesday 8 September 2026"; // 06:15 UTC
  const t = (iso: string) => new Date(iso).getTime();
  // 25 minutes later: fresh enough.
  assert.equal(isRecentIssue(issued, t("2026-09-08T06:40:00Z")), true);
  // 75 minutes later: too old.
  assert.equal(isRecentIssue(issued, t("2026-09-08T07:30:00Z")), false);
  // Exactly the threshold is still allowed.
  assert.equal(isRecentIssue(issued, t("2026-09-08T06:15:00Z") + MAX_ISSUE_AGE_MS), true);
  // An unparseable issue can't be shown fresh, so it's never sent.
  assert.equal(isRecentIssue("Issued at teatime", Date.now()), false);
});
