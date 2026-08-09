import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { DEFAULT_PREFS, sanitizePrefs, type AlertPrefs } from "@/lib/alert-prefs";

export const dynamic = "force-dynamic";

// Which incidents a device wants pushed to it (see lib/alert-prefs.ts).
//
// Keyed by push endpoint, exactly like /api/push/subscribe and /follow: the
// endpoint is a long unguessable URL minted by the push service, and holding it
// is what identifies the device. Nothing here reads the board, so this route
// needs no access token — unlike /api/incidents, it exposes no incident data.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPrefs(row: any): AlertPrefs {
  return {
    // Columns are absent on a database that hasn't had the new schema applied —
    // fall back to "everything", which is what that database is doing anyway.
    alertAll: row?.alert_all ?? true,
    lgas: row?.lgas ?? [],
    stations: row?.stations ?? [],
  };
}

// GET /api/push/prefs?endpoint=..  -> { prefs }
export async function GET(req: Request) {
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  if (!endpoint) {
    return NextResponse.json({ error: "Missing endpoint" }, { status: 422 });
  }

  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("*")
    .eq("endpoint", endpoint)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // An unknown endpoint isn't an error — the device just hasn't subscribed yet.
  return NextResponse.json({ prefs: data ? rowToPrefs(data) : DEFAULT_PREFS });
}

// PUT /api/push/prefs  { endpoint, alertAll, lgas, stations } -> save.
// Updates an existing subscription only; the device must have subscribed first.
export async function PUT(req: Request) {
  let body: { endpoint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const endpoint = body?.endpoint;
  if (!endpoint) {
    return NextResponse.json({ error: "Missing endpoint" }, { status: 422 });
  }

  const prefs = sanitizePrefs(body);
  const { data, error } = await supabase
    .from("push_subscriptions")
    .update({ alert_all: prefs.alertAll, lgas: prefs.lgas, stations: prefs.stations })
    .eq("endpoint", endpoint)
    .select("endpoint");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data?.length) {
    return NextResponse.json({ error: "Unknown subscription" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, prefs });
}
