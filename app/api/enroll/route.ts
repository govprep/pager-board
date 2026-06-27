import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// POST /api/enroll — enrol this device against an invite code.
// The code can be typed into the gate (the reliable path for an installed iOS
// PWA, which has its own storage jar) or carried by the link (?code= / ?invite=).
// One code enrols up to the member's max_devices (default 3) — covering a Safari
// tab plus the installed PWA plus a spare — then it's full. Each enrolment mints
// a distinct device_token, the browser's durable credential (refreshed via
// /api/session). Revoking the member boots every device it enrolled.
export async function POST(req: Request) {
  let code: string | undefined;
  let userAgent = "";
  try {
    const body = await req.json();
    // Accept `code` (typed or ?code=) or legacy `invite` (?invite=).
    code = (body?.code ?? body?.invite)?.toString().trim();
    userAgent = typeof body?.userAgent === "string" ? body.userAgent : "";
  } catch {
    /* fall through */
  }
  if (!code) {
    return NextResponse.json({ error: "Enter your access code." }, { status: 400 });
  }

  // Resolve the member with parameterized exact matches (no filter-string
  // interpolation). Codes are stored uppercase/alphanumeric, so normalise the
  // typed value; the long link token is matched verbatim.
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let member: any = null;
  if (normalized) {
    const r = await supabase
      .from("members")
      .select("id, max_devices, revoked_at")
      .eq("code", normalized)
      .maybeSingle();
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
    member = r.data;
  }
  if (!member) {
    const r = await supabase
      .from("members")
      .select("id, max_devices, revoked_at")
      .eq("invite_token", code)
      .maybeSingle();
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
    member = r.data;
  }

  if (!member || member.revoked_at) {
    return NextResponse.json({ error: "That code isn't valid." }, { status: 403 });
  }

  // Enforce the device cap. (Count-then-insert: a tiny race could let two
  // simultaneous enrolments both pass, which is acceptable for an anti-sharing
  // soft cap; revoking the member still clears all of them.)
  const { count } = await supabase
    .from("member_devices")
    .select("id", { count: "exact", head: true })
    .eq("member_id", member.id)
    .is("revoked_at", null);

  if ((count ?? 0) >= member.max_devices) {
    return NextResponse.json(
      { error: "That code is already used on the maximum number of devices." },
      { status: 403 },
    );
  }

  const deviceToken = randomBytes(24).toString("base64url");
  const { error: insErr } = await supabase.from("member_devices").insert({
    member_id: member.id,
    device_token: deviceToken,
    user_agent: userAgent.slice(0, 400),
    last_seen_at: new Date().toISOString(),
  });
  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ token: deviceToken }, { status: 201 });
}
