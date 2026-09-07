import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { supabase } from "./supabase";

// Access tokens for the invite-link gate.
//
// A device's durable credential is the random token minted during enrollment
// (stored client-side in localStorage). The board can't use that token
// directly for Supabase Realtime, so /api/session exchanges it for a short-lived
// JWT signed with the project's JWT secret. Because it's signed with that
// secret and carries role=authenticated, Supabase Realtime and our own API both
// accept it, which lets the incidents table stay locked to anon while enrolled
// devices still get the live feed. API verification also checks live revocation.

function signingSecret(): Uint8Array {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("SUPABASE_JWT_SECRET must contain at least 32 characters");
  return new TextEncoder().encode(secret);
}
const AUDIENCE = "authenticated";
const TTL = "1h"; // keep short so revocation is timely; client re-exchanges

/** Mint a Supabase-compatible access token for an enrolled device. */
export async function mintAccessToken(deviceId: string): Promise<string> {
  return new SignJWT({ role: AUDIENCE })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(deviceId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(signingSecret());
}

/** Verify an access token; returns the active device id or null if invalid. */
export async function verifyAccessToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, signingSecret(), {
      audience: AUDIENCE,
      algorithms: ["HS256"],
      requiredClaims: ["sub", "iat", "exp"],
      maxTokenAge: TTL,
    });
    if (payload.role !== AUDIENCE || !payload.sub) return null;
    // Service-role API queries bypass RLS, so verify revocation on every call.
    const { data, error } = await supabase
      .from("member_devices")
      .select("id, member:members!inner(id)")
      .eq("id", payload.sub)
      .is("revoked_at", null)
      .is("member.revoked_at", null)
      .maybeSingle();
    if (error) {
      console.error("Access verification failed", error.code);
      return null;
    }
    return data ? payload.sub : null;
  } catch {
    return null;
  }
}
