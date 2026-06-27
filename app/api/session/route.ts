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

  // Only an enrolled device_token grants a session. Locked out if the device or
  // its member is revoked (revoking the member boots all of its devices).
  const { data: device, error } = await supabase
    .from("member_devices")
    .select("id, revoked_at, member:members(id, label, revoked_at)")
    .eq("device_token", token)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // The embedded member comes back as an object or single-element array
  // depending on relationship inference — normalise both shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = Array.isArray((device as any)?.member) ? (device as any).member[0] : (device as any)?.member;
  if (!device || device.revoked_at || !m || m.revoked_at) {
    return NextResponse.json({ error: "Access revoked" }, { status: 403 });
  }

  // Best-effort "last seen" stamp; don't fail the login if it errors.
  await supabase
    .from("member_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", device.id);

  const accessToken = await mintAccessToken(device.id);
  return NextResponse.json({ accessToken, label: m.label });
}
