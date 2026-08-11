import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";
import type { Incident } from "../lib/types";
import {
  alertKeysFor,
  mergeAlertKeys,
  wantsIncident,
  type AlertPrefs,
} from "../lib/alert-prefs";
import { toIncident as rowToIncident } from "../lib/incident-row";
import { applianceUnits } from "../lib/units";
import { friendlyType } from "./type-names";

// Sends web-push notifications to subscribed phones. Two kinds of alert:
//
//  • New incident → goes to every device whose area preferences match (by RFS
//    LGA or FRNSW station — see lib/alert-prefs.ts). Devices that haven't
//    narrowed anything have alert_all set and still get everything. The body is
//    tailored per agency: RFS pages show the type + address; FRNSW pages
//    (marked "FRINC") show the type + the initial responding station.
//
//  • Unit added → goes only to devices following that incident. Fires when a new
//    unit page arrives for an incident number we've already seen, e.g.
//    "CMEASCR1 was added to RINGWOOD RD". Area preferences deliberately don't
//    apply here — a follow is per-incident, and the two ways to acquire one both
//    already answer the "is this mine?" question:
//
//      · the incident modal's Follow button — an explicit opt-in, usually to a
//        job outside your own patch that you want to watch;
//      · getting the new-incident alert above, having narrowed to areas — a
//        device that asked for these LGAs or stations starts following the job,
//        so the units assigned after the first page land on the same phones
//        without anyone having to open the card. Unfollowing sticks: auto-follow
//        runs once, on the alert, and never re-adds.
//
//        `alertAll` devices are deliberately left out. They haven't told us what
//        their patch is, so following on their behalf would mean every appliance
//        on every job in NSW — a firehose, not a follow-up. They can still tap
//        Follow on the jobs they care about, and narrowing to an area turns this
//        on for everything after.
//
//    Additions naming only duty officers or ops (SHDO, SHOPS14) are dropped
//    rather than sent — those capcodes are paged to nearly everything in a zone,
//    so they'd turn every followed job into a buzzing phone. See lib/units.ts.
//
// Self-filters to pages not yet pushed via incidents.pushed_at, so re-upserts of
// unchanged rows cost nothing and restarts never double-notify. Multiple unit
// pages of a brand-new incident collapse into a single new-incident alert.
//
// No-op unless the VAPID env vars are set, so the feeder runs fine without it.

let configured = false;

function configure(): boolean {
  if (configured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  // mailto: or https: contact, per the Web Push spec.
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  // Printed once, so a glance at the log says whether the process that's
  // actually sending has the area filter — a feeder started before this shipped
  // keeps running the old code and pushes everything to everyone.
  console.log(
    `[push] enabled — area filtering on, auto-follow on (${followTtlDays()}d), ` +
      `ignoring pages older than ${maxAgeMin()} min`,
  );
  return true;
}

// Don't notify for pages that arrived long ago. Re-scraping history or seeding
// re-upserts old rows with no pushed_at, and every one of them would ring as
// breaking news — the board has had March incidents buzzing phones in August.
// They're still marked pushed, so they never queue up again.
const DEFAULT_MAX_AGE_MIN = 30;

function maxAgeMin(): number {
  const raw = Number(process.env.PUSH_MAX_AGE_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_MIN;
}

function isStale(inc: Incident): boolean {
  const received = Date.parse(inc.receivedAt);
  if (!Number.isFinite(received)) return false; // no usable time → treat as live
  return Date.now() - received > maxAgeMin() * 60_000;
}

// Groups a job's pages into one notification (same key Slack threads on).
function groupKey(inc: Incident): string {
  return inc.incidentNo?.trim() || inc.id;
}

// FRNSW pages carry "FRINC"; everything else with a number we treat as RFS.
function isFrnsw(inc: Incident): boolean {
  return /\bFRINC\b/i.test(inc.raw);
}

// The first place-name in an address ("RINGWOOD RD,WONGA PARK,…" -> "RINGWOOD RD").
function firstLocationName(location: string): string {
  return (location.split(",")[0] ?? "").trim();
}

// Deep link to a specific incident card. The board reads ?incident= on load (or
// via a service-worker message when already open) and pops that card open.
function boardUrl(incidentNo: string): string {
  const base = process.env.BOARD_URL || "/";
  if (!incidentNo) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}incident=${encodeURIComponent(incidentNo)}`;
}

interface DbSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// A subscription plus the areas that device asked for.
type SubWithPrefs = DbSubscription & { prefs: AlertPrefs };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSub(row: any): SubWithPrefs {
  return {
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    prefs: {
      // A database without the preference columns reads as "everything", which
      // is what it was doing before they existed.
      alertAll: row.alert_all ?? true,
      lgas: row.lgas ?? [],
      stations: row.stations ?? [],
    },
  };
}

// Auto-follow changes the shape of `incident_subscriptions`: it was a handful of
// rows a user had tapped Follow on, and it is now roughly devices × incidents —
// tens of thousands a week, on a table read once per unit page. The rows are also
// dead almost immediately: a job stops receiving units within hours, long before
// it leaves the board. So they're swept on a timer, which keeps the lookup small
// without needing a scheduled job outside the feeder.
//
// Manual follows are swept on the same clock. A week-old job isn't getting more
// appliances, so there is nothing left to deliver on either kind.
const DEFAULT_FOLLOW_TTL_DAYS = 7;
const SWEEP_EVERY_MS = 60 * 60_000;
let lastSweep = 0;

function followTtlDays(): number {
  const raw = Number(process.env.PUSH_FOLLOW_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FOLLOW_TTL_DAYS;
}

async function sweepFollows(db: SupabaseClient): Promise<void> {
  if (Date.now() - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = Date.now();
  const cutoff = new Date(Date.now() - followTtlDays() * 86_400_000).toISOString();
  const { error } = await db.from("incident_subscriptions").delete().lt("created_at", cutoff);
  if (error) console.error("[push] sweep follows:", error.message);
}

/**
 * Sign the devices an alert just reached up to the incident's later unit pages.
 *
 * Best-effort and idempotent: a device that already follows (from the modal, or
 * from a duplicate alert) upserts onto its own row, and a failure here costs the
 * follow-ups rather than the alert that was already sent. Incidents with no
 * number can't be followed — `incident_subscriptions` is keyed on it — and there
 * is nothing to follow up anyway, since later pages wouldn't group with them.
 */
async function autoFollow(
  db: SupabaseClient,
  incidentNo: string,
  subs: DbSubscription[],
): Promise<void> {
  if (!incidentNo || !subs.length) return;
  const { error } = await db
    .from("incident_subscriptions")
    .upsert(
      subs.map((s) => ({ incident_no: incidentNo, endpoint: s.endpoint })),
      { onConflict: "incident_no,endpoint" },
    );
  if (error) console.error("[push] auto-follow:", error.message);
}

async function sendTo(subs: DbSubscription[], payload: string, dead: string[]): Promise<void> {
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410 = subscription expired or was removed → prune it.
        if (status === 404 || status === 410) dead.push(s.endpoint);
        else console.error(`[push] send failed (${status ?? "?"}):`, (err as Error).message);
      }
    }),
  );
}

interface Group {
  inc: Incident; // representative (first) page of the group
  incs: Incident[]; // every pending page in this batch for the incident
  ids: string[];
  incidentNo: string;
}

/**
 * Push any of the given incident ids that haven't been pushed yet. Safe to call
 * with the full batch of just-upserted ids; it self-filters via pushed_at.
 */
export async function pushPending(db: SupabaseClient, ids: string[]): Promise<void> {
  if (!configure() || !ids.length) return;

  await sweepFollows(db);

  const { data: rows, error } = await db
    .from("incidents")
    .select("*")
    .in("id", ids)
    .is("pushed_at", null)
    .order("received_at", { ascending: true });

  if (error) {
    console.error("[push] fetch pending:", error.message);
    return;
  }
  if (!rows?.length) return;

  // Collapse the batch into one group per real-world incident, keeping every
  // contributing page (for unit names) and id (to stamp them all pushed).
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const inc = rowToIncident(row);
    const key = groupKey(inc);
    const g = groups.get(key);
    if (g) {
      g.incs.push(inc);
      g.ids.push(inc.id);
    } else {
      groups.set(key, { inc, incs: [inc], ids: [inc.id], incidentNo: inc.incidentNo?.trim() ?? "" });
    }
  }

  // An incident is "already known" if it has earlier pages that were already
  // pushed. Those groups are unit-additions; the rest are brand-new incidents.
  const numbers = [...groups.values()].map((g) => g.incidentNo).filter(Boolean);
  const known = new Set<string>();
  if (numbers.length) {
    const { data: prior, error: priorErr } = await db
      .from("incidents")
      .select("incident_no")
      .in("incident_no", numbers)
      .not("pushed_at", "is", null);
    if (priorErr) console.error("[push] fetch prior:", priorErr.message);
    else for (const r of prior ?? []) known.add(r.incident_no);
  }

  // Every device plus its area preferences — only needed for new-incident
  // alerts, which are then narrowed per group below. Selecting "*" keeps this
  // working against a database that predates the preference columns.
  const newGroups = [...groups.values()].filter((g) => !(g.incidentNo && known.has(g.incidentNo)));
  let allSubs: SubWithPrefs[] = [];
  if (newGroups.length) {
    const { data: subs, error: subErr } = await db.from("push_subscriptions").select("*");
    if (subErr) console.error("[push] fetch subscriptions:", subErr.message);
    else allSubs = (subs ?? []).map(rowToSub);
  }

  const handled: string[] = [];
  const dead: string[] = []; // endpoints the push service has retired
  let newCount = 0;
  let updateCount = 0;
  let skippedCount = 0; // new incidents nobody's preferences asked for
  let staleCount = 0; // pages too old to be news (backfill / re-scrape)
  let supportCount = 0; // additions naming only duty officers / ops
  let followCount = 0; // follows opened for narrowed devices by a new-incident alert

  for (const g of groups.values()) {
    const { inc } = g;
    // Always mark handled so they don't re-evaluate on every future batch.
    handled.push(...g.ids);

    // Backfilled history: stamp it pushed, but don't ring anyone's phone.
    if (g.incs.every(isStale)) {
      staleCount++;
      continue;
    }

    const name = (await friendlyType(inc.type)).toUpperCase();

    if (g.incidentNo && known.has(g.incidentNo)) {
      // Unit added to a known incident → notify only its followers, and only
      // when an appliance is among the additions. Checked before the lookups so
      // a duty-officer page costs no queries.
      const units = applianceUnits(g.incs.map((i) => i.unit));
      if (!units.length) {
        supportCount++;
        continue;
      }

      const { data: follows, error: fErr } = await db
        .from("incident_subscriptions")
        .select("endpoint")
        .eq("incident_no", g.incidentNo);
      if (fErr) {
        console.error("[push] fetch followers:", fErr.message);
        continue;
      }
      const endpoints = (follows ?? []).map((f) => f.endpoint);
      if (!endpoints.length) continue;

      const { data: subs, error: sErr } = await db
        .from("push_subscriptions")
        .select("endpoint, p256dh, auth")
        .in("endpoint", endpoints);
      if (sErr) {
        console.error("[push] fetch follower subs:", sErr.message);
        continue;
      }

      const verb = units.length > 1 ? "were added to" : "was added to";
      const where = firstLocationName(inc.location) || inc.location || "this incident";
      const payload = JSON.stringify({
        title: `🚒 ${name || "INCIDENT"}`,
        body: `${units.join(", ")} ${verb} ${where}`,
        url: boardUrl(g.incidentNo),
        tag: g.incidentNo,
      });
      await sendTo((subs as DbSubscription[]) ?? [], payload, dead);
      updateCount++;
    } else {
      // New incident → notify the devices whose areas it falls in. The match
      // keys come from every page of the group, so a job paged to several FRNSW
      // stations reaches anyone watching any of them.
      newCount++;
      if (!allSubs.length) continue;

      const keys = mergeAlertKeys(g.incs.map((i) => alertKeysFor(i.location, i.raw)));
      const recipients = allSubs.filter((s) => wantsIncident(s.prefs, keys));
      if (!recipients.length) {
        skippedCount++;
        continue;
      }

      const title =
        isFrnsw(inc) && inc.unit
          ? `🚨 ${name || "INCIDENT"} · ${inc.unit}`
          : `🚨 ${name || "INCIDENT"}`;
      const body = inc.location || (isFrnsw(inc) ? "" : inc.unit) || "";
      const payload = JSON.stringify({
        title,
        body,
        url: boardUrl(inc.incidentNo),
        tag: groupKey(inc),
      });
      await sendTo(recipients, payload, dead);
      // Whoever asked for this area now follows the job, so the units assigned
      // after this first page reach them too. Endpoints the send retired are
      // pruned below, which cascades these rows away with them.
      const followers = recipients.filter((s) => !s.prefs.alertAll);
      await autoFollow(db, g.incidentNo, followers);
      followCount += followers.length;
    }
  }

  if (dead.length) {
    await db.from("push_subscriptions").delete().in("endpoint", dead);
  }

  if (handled.length) {
    const { error: upErr } = await db
      .from("incidents")
      .update({ pushed_at: new Date().toISOString() })
      .in("id", handled);
    if (upErr) console.error("[push] mark pushed:", upErr.message);
    else
      console.log(
        `[push] ${newCount} new, ${updateCount} update(s)` +
          (followCount ? `, ${followCount} auto-follow(s)` : "") +
          (supportCount ? `, ${supportCount} DO/ops-only addition(s)` : "") +
          (skippedCount ? `, ${skippedCount} outside everyone's areas` : "") +
          (staleCount ? `, ${staleCount} too old to notify` : ""),
      );
  }
}
