import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// The RPC locks the member row so concurrent requests cannot exceed its cap.
export async function POST(req: Request) {
  let body: { code?: unknown; invite?: unknown; userAgent?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Enter your access code." }, { status: 400 });
  }
  const rawCode = body?.code ?? body?.invite;
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (!code || code.length > 256) {
    return NextResponse.json({ error: "Enter your access code." }, { status: 400 });
  }

  try {
    const { data, error } = await supabase.rpc("enroll_device", {
      p_code: code,
      p_device_token: randomBytes(24).toString("base64url"),
      p_user_agent: typeof body.userAgent === "string" ? body.userAgent.slice(0, 400) : "",
    });
    if (error) {
      console.error("Device enrollment failed", error.code);
      return NextResponse.json({ error: "Unable to enrol right now. Please try again." }, { status: 503 });
    }
    const result = (data as { device_token: string | null; error_code: string | null }[] | null)?.[0];
    if (result?.error_code === "invalid_code") {
      return NextResponse.json({ error: "That code isn't valid." }, { status: 403 });
    }
    if (result?.error_code === "device_limit") {
      return NextResponse.json(
        { error: "That code is already used on the maximum number of devices." },
        { status: 403 },
      );
    }
    if (!result?.device_token || result.error_code) {
      return NextResponse.json({ error: "Unable to enrol right now. Please try again." }, { status: 503 });
    }
    return NextResponse.json({ token: result.device_token }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Unable to enrol right now. Please try again." }, { status: 503 });
  }
}
