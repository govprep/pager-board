import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { withOptionalColumns } from "@/lib/push-columns";

export const dynamic = "force-dynamic";

// A PushSubscription serialised by the browser (subscription.toJSON()), plus the
// device id lib/push-client.ts derives from the durable invite token.
interface SubscriptionBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  deviceKey?: string;
}

// POST /api/push/subscribe — save (or refresh) a device's push subscription.
//
// Push services rotate endpoints: the same phone can come back with a brand-new
// endpoint and no idea it ever had another. Left alone, the old row stays behind
// on whatever preferences it held — for a device enrolled before the area picker
// existed, that's "everything", pushed forever alongside the narrowed new row,
// which is exactly what "my areas aren't being respected" looks like from the
// phone. So when the device names itself, its old rows hand over their
// preferences and are deleted.
export async function POST(req: Request) {
  let body: SubscriptionBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "Incomplete subscription" }, { status: 422 });
  }
  // A SHA-256 hex digest or nothing — never trust the client's length or charset.
  const deviceKey = /^[0-9a-f]{64}$/.test(body.deviceKey ?? "") ? body.deviceKey! : null;

  // Preferences to seed a first insert with: the ones this device already chose
  // on a previous endpoint. Only a device that actually chose hands them over —
  // inheriting an unchosen "everything" would just relaunch the same problem.
  let inherited: Record<string, unknown> = {};
  let superseded: string[] = [];
  if (deviceKey) {
    // Silently finds nothing on a database that predates device_key — the
    // reconcile simply doesn't happen until the schema is applied.
    const { data: siblings } = await supabase
      .from("push_subscriptions")
      .select("endpoint, alert_all, lgas, stations, prefs_set_at")
      .eq("device_key", deviceKey);

    superseded = (siblings ?? []).map((s) => s.endpoint).filter((e) => e !== endpoint);

    const chosen = (siblings ?? [])
      .filter((s) => s.prefs_set_at)
      .sort((a, b) => Date.parse(b.prefs_set_at) - Date.parse(a.prefs_set_at))[0];
    if (chosen) {
      inherited = {
        alert_all: chosen.alert_all,
        lgas: chosen.lgas,
        stations: chosen.stations,
        prefs_set_at: chosen.prefs_set_at,
      };
    }
  }

  // Only the connection details are overwritten on conflict — a device that
  // re-subscribes on the endpoint it already has keeps the areas it picked.
  // device_key is left out when we don't have one, so a browser that can't
  // compute it (storage blocked) doesn't erase the id the row already carries.
  const { error } = await withOptionalColumns(
    { ...(deviceKey ? { device_key: deviceKey } : {}), ...inherited },
    (extras) =>
      supabase
        .from("push_subscriptions")
        .upsert({ endpoint, p256dh, auth, ...extras }, { onConflict: "endpoint" }),
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Drop the endpoints this one replaced (cascades to their incident follows).
  if (superseded.length) {
    const { error: pruneErr } = await supabase
      .from("push_subscriptions")
      .delete()
      .in("endpoint", superseded);
    if (pruneErr) console.error("[push] prune superseded:", pruneErr.message);
  }

  return NextResponse.json({ ok: true, superseded: superseded.length }, { status: 201 });
}

// DELETE /api/push/subscribe — remove a device's subscription (unsubscribe).
export async function DELETE(req: Request) {
  let endpoint: string | undefined;
  try {
    endpoint = (await req.json())?.endpoint;
  } catch {
    /* fall through */
  }
  if (!endpoint) {
    return NextResponse.json({ error: "Missing endpoint" }, { status: 422 });
  }

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
