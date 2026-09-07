import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { pushBody, pushDevice, pushFailure, requireOwnedSubscription } from "@/lib/push-auth";
import { isIncidentNumber, isPushEndpoint } from "@/lib/push-validation";

export const dynamic = "force-dynamic";

async function follow(req: Request, method: "GET" | "POST" | "DELETE") {
  const deviceId = await pushDevice(req);
  if (typeof deviceId !== "string") return deviceId;
  const params = new URL(req.url).searchParams;
  const body = method === "GET" ? { incidentNo: params.get("incidentNo"), endpoint: params.get("endpoint") } : await pushBody(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON object" }, { status: 400 });
  const { incidentNo, endpoint } = body;
  if (!isIncidentNumber(incidentNo) || !isPushEndpoint(endpoint)) {
    return NextResponse.json({ error: "Invalid incidentNo or endpoint" }, { status: 422 });
  }
  const denied = await requireOwnedSubscription(deviceId, endpoint);
  if (denied) return denied;
  if (method === "GET") {
    const { data, error } = await supabase.from("incident_subscriptions").select("incident_no")
      .eq("incident_no", incidentNo).eq("endpoint", endpoint).maybeSingle();
    if (error) return pushFailure(error);
    return NextResponse.json({ following: !!data });
  }
  const { error } = method === "POST"
    ? await supabase.from("incident_subscriptions").upsert({ incident_no: incidentNo, endpoint }, { onConflict: "incident_no,endpoint" })
    : await supabase.from("incident_subscriptions").delete().eq("incident_no", incidentNo).eq("endpoint", endpoint);
  if (error) return pushFailure(error);
  return NextResponse.json({ ok: true }, { status: method === "POST" ? 201 : 200 });
}

export function GET(req: Request) { return follow(req, "GET"); }
export function POST(req: Request) { return follow(req, "POST"); }
export function DELETE(req: Request) { return follow(req, "DELETE"); }
