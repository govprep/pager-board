import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";
import type { Incident } from "../lib/types";
import {
  alertKeysFor,
  mergeAlertKeys,
  wantsIncident,
  type AlertPrefs,
} from "../lib/alert-prefs";
import { friendlyType } from "./type-names";

// Sends web-push notifications to subscribed phones. Two kinds of alert:
//
//  • New incident → goes to every device whose area preferences match (by RFS
//    LGA or FRNSW station — see lib/alert-prefs.ts). Devices that haven't
//    narrowed anything have alert_all set and still get everything. The body is
//    tailored per agency: RFS pages show the type + address; FRNSW pages
//    (marked "FRINC") show the type + the initial responding station.
//
//  • Unit added → goes only to devices following that incident (from the
//    incident modal). Fires when a new unit page arrives for an incident number
//    we've already seen, e.g. "CMEASCR1 was added to RINGWOOD RD". Area
//    preferences deliberately don't apply here: following one job is an explicit
//    opt-in, and it's usually a job outside your own patch that you're watching.
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
  console.log(`[push] enabled — area filtering on, ignoring pages older than ${maxAgeMin()} min`);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToIncident(row: any): Incident {
  return {
    id: row.id,
    incidentNo: row.incident_no,
    type: row.type,
    unit: row.unit,
    location: row.location,
    coords: row.coords ?? null,
    receivedAt: row.received_at,
    fields: row.fields ?? {},
    raw: row.raw,
    stoppedAt: row.stopped_at ?? null,
  };
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
      // Unit added to a known incident → notify only its followers.
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

      const units = g.incs.map((i) => i.unit).filter(Boolean);
      const verb = units.length > 1 ? "were added to" : "was added to";
      const where = firstLocationName(inc.location) || inc.location || "this incident";
      const payload = JSON.stringify({
        title: `🚒 ${name || "INCIDENT"}`,
        body: `${units.join(", ") || "A unit"} ${verb} ${where}`,
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
          (skippedCount ? `, ${skippedCount} outside everyone's areas` : "") +
          (staleCount ? `, ${staleCount} too old to notify` : ""),
      );
  }
}
