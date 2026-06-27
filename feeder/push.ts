import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";
import type { Incident } from "../lib/types";
import { friendlyType } from "./type-names";

// Sends web-push notifications to subscribed phones. Two kinds of alert:
//
//  • New incident → goes to every subscribed device. The body is tailored per
//    agency: RFS pages show the type + address; FRNSW pages (marked "FRINC")
//    show the type + the initial responding station.
//
//  • Unit added → goes only to devices following that incident (from the
//    incident modal). Fires when a new unit page arrives for an incident number
//    we've already seen, e.g. "CMEASCR1 was added to RINGWOOD RD".
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
  return true;
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

interface DbSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
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

  // Global subscribers (every device) — only needed for new-incident alerts.
  const newGroups = [...groups.values()].filter((g) => !(g.incidentNo && known.has(g.incidentNo)));
  let globalSubs: DbSubscription[] = [];
  if (newGroups.length) {
    const { data: subs, error: subErr } = await db
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth");
    if (subErr) console.error("[push] fetch subscriptions:", subErr.message);
    else globalSubs = (subs as DbSubscription[]) ?? [];
  }

  const handled: string[] = [];
  const dead: string[] = []; // endpoints the push service has retired
  let newCount = 0;
  let updateCount = 0;

  for (const g of groups.values()) {
    const { inc } = g;
    // Always mark handled so they don't re-evaluate on every future batch.
    handled.push(...g.ids);

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
        url: process.env.BOARD_URL || "/",
        tag: g.incidentNo,
      });
      await sendTo((subs as DbSubscription[]) ?? [], payload, dead);
      updateCount++;
    } else {
      // New incident → notify everyone. FRNSW folds the initial station into the
      // type line; both agencies show the address in the body.
      newCount++;
      if (!globalSubs.length) continue;

      const title =
        isFrnsw(inc) && inc.unit
          ? `🚨 ${name || "INCIDENT"} · ${inc.unit}`
          : `🚨 ${name || "INCIDENT"}`;
      const body = inc.location || (isFrnsw(inc) ? "" : inc.unit) || "";
      const payload = JSON.stringify({
        title,
        body,
        url: process.env.BOARD_URL || "/",
        tag: groupKey(inc),
      });
      await sendTo(globalSubs, payload, dead);
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
    else console.log(`[push] ${newCount} new, ${updateCount} update(s)`);
  }
}
