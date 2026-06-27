import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parsePagerMessage, hasIncidentNumber } from "../lib/parser";
import type { Incident } from "../lib/types";
import { postPending } from "./slack";
import { pushPending } from "./push";

export interface PagerLine {
  raw: string;
  receivedAt?: string; // ISO string — defaults to now() if omitted
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

  const db: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  });

  async function clear() {
    const { error } = await db.from("incidents").delete().neq("id", "");
    if (error) throw new Error(error.message);
    // Drop thread mappings too, so a re-ingest starts fresh parent messages
    // instead of replying into now-orphaned Slack threads.
    await db.from("incident_threads").delete().neq("incident_no", "");
  }

  async function write(lines: PagerLine[], source: string) {
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

    const { data, error } = await db
      .from("incidents")
      .upsert(unique, { onConflict: "id" })
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
