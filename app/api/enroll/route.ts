import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// POST /api/enroll — redeem a single-use invite link for a device credential.
// The browser calls this once, the first time a device opens an invite link.
// The claim is atomic and one-shot: it sets device_token + claimed_at only while
// claimed_at is still null, so a link enrols exactly one device and is then dead.
// The returned device_token is the browser's durable credential (refreshed via
// /api/session). The original invite_token is never accepted by /api/session.
export async function POST(req: Request) {
  let invite: string | undefined;
  let userAgent = "";
  try {
    const body = await req.json();
    invite = body?.invite;
    userAgent = typeof body?.userAgent === "string" ? body.userAgent : "";
  } catch {
    /* fall through */
  }
  if (!invite) {
    return NextResponse.json({ error: "Missing invite token" }, { status: 400 });
  }

  const deviceToken = randomBytes(24).toString("base64url");

  // Atomic single-use claim: only succeeds while the link is unclaimed, not
  // revoked, and the invite_token matches. A second attempt matches no row → 403.
  const { data, error } = await supabase
    .from("members")
    .update({
      device_token: deviceToken,
      claimed_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      user_agent: userAgent.slice(0, 400),
    })
    .eq("invite_token", invite)
    .is("claimed_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    // Unknown, already-used, or revoked link.
    return NextResponse.json({ error: "Invite link is invalid or already used" }, { status: 403 });
  }

  // The device's durable credential — stored client-side, refreshed via /api/session.
  return NextResponse.json({ token: deviceToken }, { status: 201 });
}
