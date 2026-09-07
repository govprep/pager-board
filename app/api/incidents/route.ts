import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { listIncidents, addRawMessages, clearStore } from "@/lib/store";
import { verifyAccessToken } from "@/lib/access";
import { readPagination, validateLines } from "@/lib/query";

export const dynamic = "force-dynamic";

// True when the request carries a valid access token minted by /api/session.
// The board is members-only, so reads require an enrolled (invited) device.
async function isAuthed(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return false;
  return (await verifyAccessToken(token)) !== null;
}

/** Constant-time string compare — no early exit on the first differing byte. */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// True for an ADMIN request: one carrying the service role key.
//
// Deliberately stricter than isAuthed(). Wiping the board is an admin action,
// and every enrolled member holds a valid access token — gating on that would
// let any member destroy the board for everyone. This project has no HTTP admin
// auth of its own; admin work (scripts/access.ts, the feeder) is done by holding
// the service role key, so that's the credential this matches.
function isAdmin(req: Request): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!key) return false; // never allow when the server has no secret configured
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token !== "" && secretsMatch(token, key);
}

// GET /api/incidents  -> a page of the board, newest first. Members only.
// Query params (all optional):
//   limit     page size (default 200, capped at 500)
//   before    received_at of the oldest row you have  ┐ keyset cursor for
//   beforeId  id of that same row                      ┘ the next older page
//   q         free-text search across the whole table, not just this page
export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let page: ReturnType<typeof readPagination>;
  try {
    page = readPagination(new URL(req.url).searchParams, "beforeId");
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
  try {
    const incidents = await listIncidents(page.limit, page.before, page.key, page.q);
    return NextResponse.json({ incidents });
  } catch (error) {
    console.error("[incidents] list failed", error);
    return NextResponse.json({ error: "Unable to load incidents" }, { status: 503 });
  }
}

// POST /api/incidents -> ingest raw pager line(s).
// Body accepts any of:
//   { "message": "2 STSUTTO - 26-... - ..." }
//   { "messages": ["line1", "line2"] }
//   plain text body (one line per row)
//
// Example:
//   curl -X POST https://belter.cmssweb.com.au/api/incidents \
//     -H "Content-Type: application/json" \
//     -d '{"message":"2 STSUTTO - 26-118999 - Test fire - FIRECALL - 1 TEST ST,SUTTON,YASS VALLEY (NSW),2620 - [149.25,-35.15]"}'
export async function POST(req: Request) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let lines: string[] = [];

  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = await req.json();
      if (typeof body?.message === "string") lines = [body.message];
      else if (Array.isArray(body?.messages)) lines = body.messages;
      else if (typeof body === "string") lines = [body];
    } else {
      const text = await req.text();
      lines = text.split(/\r?\n/);
    }
    lines = validateLines(lines);
  } catch {
    return NextResponse.json({ error: "Could not read request body" }, { status: 400 });
  }

  let added;
  try {
    added = await addRawMessages(lines);
  } catch (error) {
    console.error("[incidents] ingestion failed", error);
    return NextResponse.json({ error: "Unable to ingest messages" }, { status: 503 });
  }
  if (added.length === 0) {
    return NextResponse.json(
      { error: "No valid pager lines found in request" },
      { status: 422 },
    );
  }
  return NextResponse.json({ added }, { status: 201 });
}

// DELETE /api/incidents -> wipe the board. Admin only:
//
//   curl -X DELETE https://belter.cmssweb.com.au/api/incidents \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
//
// Leaves `pager_messages` alone — the raw feed is an append-only record of what
// came over the air, so a board reset doesn't erase it.
export async function DELETE(req: Request) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await clearStore();
    return NextResponse.json({ cleared: true });
  } catch (error) {
    console.error("[incidents] clear failed", error);
    return NextResponse.json({ error: "Unable to clear incidents" }, { status: 503 });
  }
}
