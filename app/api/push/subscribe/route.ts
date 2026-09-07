import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { pushBody, pushDevice, pushFailure, requireOwnedSubscription } from "@/lib/push-auth";
import { isPushEndpoint, isPushKey } from "@/lib/push-validation";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const deviceId = await pushDevice(req);
  if (typeof deviceId !== "string") return deviceId;
  const body = await pushBody(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON object" }, { status: 400 });
  const { endpoint } = body;
  const keys = body.keys as Record<string, unknown> | null;
  if (!isPushEndpoint(endpoint) || !isPushKey(keys?.p256dh, 65) || !isPushKey(keys?.auth, 16)) {
    return NextResponse.json({ error: "Invalid push subscription" }, { status: 422 });
  }

  // Ownership comes from the verified session, never a client-supplied deviceKey.
  const { data: device, error: deviceError } = await supabase.from("member_devices")
    .select("device_token").eq("id", deviceId).is("revoked_at", null).maybeSingle();
  if (deviceError) return pushFailure(deviceError);
  if (!device) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const deviceKey = createHash("sha256").update(device.device_token).digest("hex");

  const { data: existing, error: existingError } = await supabase.from("push_subscriptions")
    .select("device_id").eq("endpoint", endpoint).maybeSingle();
  if (existingError) return pushFailure(existingError);
  if (existing && existing.device_id !== deviceId) {
    return NextResponse.json({ error: "Subscription unavailable" }, { status: 409 });
  }
  const { data: siblings, error: siblingsError } = await supabase.from("push_subscriptions")
    .select("endpoint, alert_all, lgas, stations, prefs_set_at")
    .eq("device_id", deviceId).order("prefs_set_at", { ascending: false, nullsFirst: false });
  if (siblingsError) return pushFailure(siblingsError);
  const chosen = siblings?.find((s) => s.prefs_set_at);
  const inherited = !existing && chosen ? {
    alert_all: chosen.alert_all, lgas: chosen.lgas, stations: chosen.stations, prefs_set_at: chosen.prefs_set_at,
  } : {};
  const connection = { p256dh: keys.p256dh, auth: keys.auth, device_key: deviceKey };
  // A separate insert makes a simultaneous claim fail on the endpoint's unique
  // key. An upsert could overwrite another device after the ownership check.
  const { data: saved, error } = existing
    ? await supabase.from("push_subscriptions").update(connection)
      .eq("endpoint", endpoint).eq("device_id", deviceId).select("endpoint")
    : await supabase.from("push_subscriptions").insert({ endpoint, device_id: deviceId, ...connection, ...inherited })
      .select("endpoint");
  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "Subscription changed. Please retry." }, { status: 409 });
    return pushFailure(error);
  }
  if (!saved?.length) return NextResponse.json({ error: "Unknown subscription" }, { status: 404 });
  const superseded = (siblings ?? []).map((s) => s.endpoint).filter((e) => e !== endpoint);
  if (superseded.length) {
    const { error: pruneError } = await supabase.from("push_subscriptions").delete()
      .eq("device_id", deviceId).in("endpoint", superseded);
    if (pruneError) return pushFailure(pruneError);
  }
  return NextResponse.json({ ok: true, superseded: superseded.length }, { status: 201 });
}

export async function DELETE(req: Request) {
  const deviceId = await pushDevice(req);
  if (typeof deviceId !== "string") return deviceId;
  const body = await pushBody(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON object" }, { status: 400 });
  if (!isPushEndpoint(body.endpoint)) return NextResponse.json({ error: "Invalid endpoint" }, { status: 422 });
  const denied = await requireOwnedSubscription(deviceId, body.endpoint);
  if (denied) return denied;
  const { error } = await supabase.from("push_subscriptions").delete()
    .eq("endpoint", body.endpoint).eq("device_id", deviceId);
  if (error) return pushFailure(error);
  return NextResponse.json({ ok: true });
}
