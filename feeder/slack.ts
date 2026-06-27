import type { SupabaseClient } from "@supabase/supabase-js";
import type { Incident } from "../lib/types";
import { channelForLocation } from "../lib/area-channels";
import { staticMapUrl } from "../lib/maps";
import { friendlyType } from "./type-names";

// Posts incidents to Slack as one parent message per real-world incident, with
// each responding unit appearing as a threaded reply.
//
//   #area-wamboin
//   └─ 🚨 INCIDENT: STRUCTURE FIRE
//      34 Bingley Way, Wamboin, Queanbeyan-Palerang   [map]
//      ├─ LGWAMBO1A assigned to this incident.
//      └─ 428 QUEANBEYAN assigned to this incident.
//
// Threading is keyed on the incident number (shared across a job's pages); pages
// with no number fall back to their own id so they stand alone. State lives in
// the incident_threads table + incidents.slacked_at, so restarts and re-sent
// pages never double-post.

const SLACK_API = "https://slack.com/api/chat.postMessage";

interface SlackResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function postMessage(token: string, body: Record<string, any>): Promise<SlackResult> {
  try {
    const res = await fetch(SLACK_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as SlackResult;
    return data;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// The key that groups a job's pages into one thread.
function groupKey(inc: Incident): string {
  return inc.incidentNo?.trim() || inc.id;
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

async function buildParentBlocks(inc: Incident) {
  const name = (await friendlyType(inc.type)).toUpperCase();
  const map = staticMapUrl(inc.coords);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: `🚨 INCIDENT: ${name}`.slice(0, 150) } },
    { type: "section", text: { type: "mrkdwn", text: inc.location || "_no location given_" } },
  ];
  if (map) blocks.push({ type: "image", image_url: map, alt_text: "incident location" });

  const meta = [inc.incidentNo, new Date(inc.receivedAt).toLocaleString("en-AU")]
    .filter(Boolean)
    .join(" · ");
  if (meta) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: meta }] });

  return { blocks, fallback: `INCIDENT: ${name} — ${inc.location}` };
}

/**
 * Post any of the given incident ids that haven't been sent to Slack yet.
 * Safe to call with the full batch of just-upserted ids; it self-filters to the
 * unposted ones via incidents.slacked_at and processes them oldest-first.
 */
export async function postPending(db: SupabaseClient, ids: string[]): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !ids.length) return;

  const { data, error } = await db
    .from("incidents")
    .select("*")
    .in("id", ids)
    .is("slacked_at", null)
    .order("received_at", { ascending: true });

  if (error) {
    console.error("[slack] fetch pending:", error.message);
    return;
  }
  if (!data?.length) return;

  const done: string[] = [];

  for (const row of data) {
    const inc = rowToIncident(row);
    const channel = channelForLocation(inc.location);

    // No channel and no default configured — nothing to do. Mark it handled so
    // we don't re-evaluate it on every future batch.
    if (!channel) {
      done.push(inc.id);
      continue;
    }

    const key = groupKey(inc);

    // Find (or create) the thread for this incident.
    const { data: existing } = await db
      .from("incident_threads")
      .select("channel, thread_ts")
      .eq("incident_no", key)
      .maybeSingle();

    let threadChannel = existing?.channel;
    let threadTs = existing?.thread_ts;

    if (!threadTs) {
      const { blocks, fallback } = await buildParentBlocks(inc);
      const parent = await postMessage(token, { channel, text: fallback, blocks });
      if (!parent.ok || !parent.ts) {
        console.error(`[slack] parent post failed (${key}):`, parent.error);
        continue; // leave slacked_at null → retry next batch
      }
      threadChannel = channel;
      threadTs = parent.ts;

      const { error: tErr } = await db
        .from("incident_threads")
        .insert({ incident_no: key, channel, thread_ts: threadTs });
      // A concurrent batch may have created it first; that's fine.
      if (tErr && !/duplicate key/i.test(tErr.message)) {
        console.error(`[slack] thread save failed (${key}):`, tErr.message);
      }
    }

    // Post this unit's assignment into the thread.
    const reply = await postMessage(token, {
      channel: threadChannel,
      thread_ts: threadTs,
      text: `${inc.unit || "A unit"} assigned to this incident.`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${inc.unit || "A unit"}* assigned to this incident.` },
        },
      ],
    });

    if (!reply.ok) {
      console.error(`[slack] reply post failed (${inc.id}):`, reply.error);
      continue; // retry next batch
    }

    done.push(inc.id);
  }

  if (done.length) {
    const { error: upErr } = await db
      .from("incidents")
      .update({ slacked_at: new Date().toISOString() })
      .in("id", done);
    if (upErr) console.error("[slack] mark slacked:", upErr.message);
    console.log(`[slack] posted ${done.length} page(s)`);
  }
}
