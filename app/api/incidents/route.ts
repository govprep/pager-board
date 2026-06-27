import { NextResponse } from "next/server";
import { listIncidents, addRawMessages, clearStore } from "@/lib/store";
import { verifyAccessToken } from "@/lib/access";

export const dynamic = "force-dynamic";

// True when the request carries a valid access token minted by /api/session.
// The board is members-only, so reads require an enrolled (invited) device.
async function isAuthed(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return false;
  return (await verifyAccessToken(token)) !== null;
}

// GET /api/incidents  -> current board, newest first. Members only.
export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const incidents = await listIncidents();
  return NextResponse.json({ incidents });
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
  } catch {
    return NextResponse.json({ error: "Could not read request body" }, { status: 400 });
  }

  const added = await addRawMessages(lines);
  if (added.length === 0) {
    return NextResponse.json(
      { error: "No valid pager lines found in request" },
      { status: 422 },
    );
  }
  return NextResponse.json({ added }, { status: 201 });
}

// DELETE /api/incidents -> wipe the board.
export async function DELETE() {
  await clearStore();
  return NextResponse.json({ cleared: true });
}
