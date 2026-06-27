import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { mintAccessToken } from "@/lib/access";

export const dynamic = "force-dynamic";

// POST /api/session — exchange a device's durable token (minted by /api/enroll,
// kept in the browser's localStorage) for a short-lived access token. Called on
// every app load and periodically to refresh. A missing, unknown, or revoked
// token gets 403 — that's how access is "policed": revoke the device and its
// next refresh is refused, locking it out within one token lifetime.
export async function POST(req: Request) {
  let token: string | undefined;
  try {
    token = (await req.json())?.token;
  } catch {
    /* fall through */
  }
  if (!token) {
    return NextResponse.json({ error: "Missing device token" }, { status: 400 });
  }

  // Only a claimed device_token grants a session — never a raw invite_token.
  const { data: member, error } = await supabase
    .from("members")
    .select("id, label, revoked_at")
    .eq("device_token", token)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!member || member.revoked_at) {
    return NextResponse.json({ error: "Access revoked" }, { status: 403 });
  }

  // Best-effort "last seen" stamp; don't fail the login if it errors.
  await supabase
    .from("members")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", member.id);

  const accessToken = await mintAccessToken(member.id);
  return NextResponse.json({ accessToken, label: member.label });
}
