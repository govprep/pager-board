import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";
import type { Incident } from "../lib/types";
import { friendlyType } from "./type-names";

// Sends a web-push notification per new incident to every subscribed phone.
//
// Same shape as the Slack mirror (feeder/slack.ts): self-filters to pages not
// yet pushed via incidents.pushed_at, so re-upserts of unchanged rows cost
// nothing and restarts never double-notify. Multiple unit pages of one job
// (shared incident number) collapse into a single notification.
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

interface DbSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
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

  const { data: subs, error: subErr } = await db
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth");

  if (subErr) {
    console.error("[push] fetch subscriptions:", subErr.message);
    return;
  }

  // Collapse the batch into one notification per real-world incident, keeping
  // every contributing row id so we can stamp them all pushed.
  const groups = new Map<string, { inc: Incident; ids: string[] }>();
  for (const row of rows) {
    const inc = rowToIncident(row);
    const key = groupKey(inc);
    const g = groups.get(key);
    if (g) g.ids.push(inc.id);
    else groups.set(key, { inc, ids: [inc.id] });
  }

  const handled: string[] = [];
  const dead: string[] = []; // endpoints the push service has retired

  for (const { inc, ids: groupIds } of groups.values()) {
    // Even with no subscribers we mark these handled so they don't re-evaluate
    // on every future batch.
    handled.push(...groupIds);
    if (!(subs as DbSubscription[] | null)?.length) continue;

    const name = (await friendlyType(inc.type)).toUpperCase();
    const payload = JSON.stringify({
      title: `🚨 ${name || "INCIDENT"}`,
      body: [inc.location, inc.unit].filter(Boolean).join("\n"),
      url: process.env.BOARD_URL || "/",
      tag: groupKey(inc),
    });

    await Promise.all(
      (subs as DbSubscription[]).map(async (s) => {
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

  if (dead.length) {
    await db.from("push_subscriptions").delete().in("endpoint", dead);
  }

  if (handled.length) {
    const { error: upErr } = await db
      .from("incidents")
      .update({ pushed_at: new Date().toISOString() })
      .in("id", handled);
    if (upErr) console.error("[push] mark pushed:", upErr.message);
    else console.log(`[push] notified ${groups.size} incident(s)`);
  }
}
