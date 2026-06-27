import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface FollowBody {
  incidentNo?: string;
  endpoint?: string;
}

// GET /api/push/follow?incidentNo=..&endpoint=..  -> { following: boolean }
// Lets the modal reflect whether this device already follows the incident.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const incidentNo = searchParams.get("incidentNo");
  const endpoint = searchParams.get("endpoint");
  if (!incidentNo || !endpoint) {
    return NextResponse.json({ error: "Missing incidentNo or endpoint" }, { status: 422 });
  }

  const { data, error } = await supabase
    .from("incident_subscriptions")
    .select("incident_no")
    .eq("incident_no", incidentNo)
    .eq("endpoint", endpoint)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ following: !!data });
}

// POST /api/push/follow  { incidentNo, endpoint } -> follow unit-added updates.
export async function POST(req: Request) {
  let body: FollowBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { incidentNo, endpoint } = body;
  if (!incidentNo || !endpoint) {
    return NextResponse.json({ error: "Missing incidentNo or endpoint" }, { status: 422 });
  }

  const { error } = await supabase
    .from("incident_subscriptions")
    .upsert({ incident_no: incidentNo, endpoint }, { onConflict: "incident_no,endpoint" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}

// DELETE /api/push/follow  { incidentNo, endpoint } -> stop following.
export async function DELETE(req: Request) {
  let body: FollowBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { incidentNo, endpoint } = body;
  if (!incidentNo || !endpoint) {
    return NextResponse.json({ error: "Missing incidentNo or endpoint" }, { status: 422 });
  }

  const { error } = await supabase
    .from("incident_subscriptions")
    .delete()
    .eq("incident_no", incidentNo)
    .eq("endpoint", endpoint);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
