import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sanitizePrefs } from "@/lib/alert-prefs";
import { pushBody, pushDevice, pushFailure } from "@/lib/push-auth";
import { isPushEndpoint } from "@/lib/push-validation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const deviceId = await pushDevice(req);
  if (typeof deviceId !== "string") return deviceId;
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  if (!isPushEndpoint(endpoint)) return NextResponse.json({ error: "Invalid endpoint" }, { status: 422 });
  const { data, error } = await supabase.from("push_subscriptions")
    .select("alert_all, lgas, stations, fire_digest, prefs_set_at")
    .eq("endpoint", endpoint).eq("device_id", deviceId).maybeSingle();
  if (error) return pushFailure(error);
  if (!data) return NextResponse.json({ error: "Unknown subscription" }, { status: 404 });
  return NextResponse.json({
    prefs: {
      alertAll: data.alert_all,
      lgas: data.lgas,
      stations: data.stations,
      fireDigest: data.fire_digest,
    },
    chosen: !!data.prefs_set_at,
  });
}

export async function PUT(req: Request) {
  const deviceId = await pushDevice(req);
  if (typeof deviceId !== "string") return deviceId;
  const body = await pushBody(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON object" }, { status: 400 });
  if (!isPushEndpoint(body.endpoint)) return NextResponse.json({ error: "Invalid endpoint" }, { status: 422 });
  if (typeof body.alertAll !== "boolean" || !Array.isArray(body.lgas) || !Array.isArray(body.stations)) {
    return NextResponse.json({ error: "Invalid preferences" }, { status: 422 });
  }
  const prefs = sanitizePrefs(body);
  const { data, error } = await supabase.from("push_subscriptions").update({
    alert_all: prefs.alertAll, lgas: prefs.lgas, stations: prefs.stations,
    fire_digest: prefs.fireDigest, prefs_set_at: new Date().toISOString(),
  }).eq("endpoint", body.endpoint).eq("device_id", deviceId).select("endpoint");
  if (error) return pushFailure(error);
  if (!data?.length) return NextResponse.json({ error: "Unknown subscription" }, { status: 404 });
  return NextResponse.json({ ok: true, prefs });
}
