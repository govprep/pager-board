import "server-only";
import { NextResponse } from "next/server";
import { verifyAccessToken } from "./access";
import { supabase } from "./supabase";

export async function pushDevice(req: Request): Promise<string | NextResponse> {
  const token = req.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
  const deviceId = token ? await verifyAccessToken(token) : null;
  return deviceId ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function pushFailure(error: { message: string }): NextResponse {
  console.error("[push] database:", error.message);
  return NextResponse.json({ error: "Unable to update notification settings. Please retry." }, { status: 500 });
}

export async function requireOwnedSubscription(deviceId: string, endpoint: string): Promise<NextResponse | null> {
  const { data, error } = await supabase.from("push_subscriptions")
    .select("endpoint").eq("endpoint", endpoint).eq("device_id", deviceId).maybeSingle();
  if (error) return pushFailure(error);
  return data ? null : NextResponse.json({ error: "Unknown subscription" }, { status: 404 });
}

/** Normalize JSON primitives to null so malformed bodies never become exceptions. */
export async function pushBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await req.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}
