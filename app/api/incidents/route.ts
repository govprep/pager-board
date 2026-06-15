import { NextResponse } from "next/server";
import { listIncidents, addRawMessages, clearStore } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/incidents  -> current board, newest first.
export function GET() {
  return NextResponse.json({ incidents: listIncidents() });
}

// POST /api/incidents -> ingest raw pager line(s).
// Body accepts any of:
//   { "message": "2 STSUTTO - 26-... - ..." }
//   { "messages": ["line1", "line2"] }
//   plain text body (one line per row)
//
// Example:
//   curl -X POST http://localhost:3000/api/incidents \
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

  const added = addRawMessages(lines);
  if (added.length === 0) {
    return NextResponse.json(
      { error: "No valid pager lines found in request" },
      { status: 422 },
    );
  }
  return NextResponse.json({ added }, { status: 201 });
}

// DELETE /api/incidents -> wipe the board (does not reseed sample data).
export function DELETE() {
  clearStore();
  return NextResponse.json({ cleared: true });
}
