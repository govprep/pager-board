import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { mintAccessToken } from "@/lib/access";

export const dynamic = "force-dynamic";

type Member = { id: string; label: string; revoked_at: string | null };
type Device = { id: string; revoked_at: string | null; member: Member | Member[] | null };

export async function POST(req: Request) {
  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    // Malformed requests use the same validation response as a missing token.
  }
  if (typeof token !== "string" || !token || token.length > 256) {
    return NextResponse.json({ error: "Missing device token" }, { status: 400 });
  }

  try {
    const { data, error } = await supabase
      .from("member_devices")
      .select("id, revoked_at, member:members(id, label, revoked_at)")
      .eq("device_token", token)
      .maybeSingle();
    if (error) {
      console.error("Session lookup failed", error.code);
      return NextResponse.json({ error: "Unable to start a session. Please try again." }, { status: 503 });
    }
    const device = data as Device | null;
    const member = Array.isArray(device?.member) ? device.member[0] : device?.member;
    if (!device || device.revoked_at || !member || member.revoked_at) {
      return NextResponse.json({ error: "Access revoked" }, { status: 403 });
    }

    const accessToken = await mintAccessToken(device.id);
    // Presence is best effort; a failed stamp must not invalidate a valid login.
    const { error: seenError } = await supabase
      .from("member_devices")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", device.id);
    if (seenError) console.error("Device presence update failed", seenError.code);

    return NextResponse.json({ accessToken, label: member.label }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Unable to start a session. Please try again." }, { status: 503 });
  }
}
