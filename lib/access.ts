import "server-only";
import { SignJWT, jwtVerify } from "jose";

// Access tokens for the invite-link gate.
//
// A member's durable credential is the random token embedded in their invite
// link (stored client-side in localStorage). The board can't use that token
// directly for Supabase Realtime, so /api/session exchanges it for a short-lived
// JWT signed with the project's JWT secret. Because it's signed with that
// secret and carries role=authenticated, Supabase Realtime and our own API both
// accept it — which lets the incidents table stay locked to anon while enrolled
// devices still get the live feed. Short TTL means revoking a member (in the DB)
// takes effect within one token lifetime, since the next exchange is refused.

const SECRET = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET ?? "");
const AUDIENCE = "authenticated";
const TTL = "1h"; // keep short so revocation is timely; client re-exchanges

/** Mint a Supabase-compatible access token for an enrolled member. */
export async function mintAccessToken(memberId: string): Promise<string> {
  return new SignJWT({ role: AUDIENCE })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(memberId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(SECRET);
}

/** Verify an access token; returns the member id (sub) or null if invalid. */
export async function verifyAccessToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET, { audience: AUDIENCE });
    return payload.role === AUDIENCE && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
