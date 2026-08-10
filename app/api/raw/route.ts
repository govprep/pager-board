import { NextResponse } from "next/server";
import { listPagerMessages } from "@/lib/store";
import { verifyAccessToken } from "@/lib/access";
import type { RawStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES: RawStatus[] = ["incident", "standdown", "dropped"];

// True when the request carries a valid access token minted by /api/session.
// The raw feed is members-only for the same reason the board is.
async function isAuthed(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return false;
  return (await verifyAccessToken(token)) !== null;
}

// GET /api/raw -> a page of the raw pager feed, newest first. Members only.
// Query params (all optional):
//   limit       page size (default 200, capped at 500)
//   before      received_at of the oldest row you have  ┐ keyset cursor for
//   beforeHash  hash of that same row                    ┘ the next older page
//   q           free-text search against the raw line
//   status      incident | standdown | dropped
//   incidentNo  every line tied to one incident number (the board's card view)
export async function GET(req: Request) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 500);
  const before = url.searchParams.get("before") ?? undefined;
  const beforeHash = url.searchParams.get("beforeHash") ?? undefined;
  const q = url.searchParams.get("q")?.trim() || undefined;

  const statusParam = url.searchParams.get("status");
  const status = STATUSES.includes(statusParam as RawStatus)
    ? (statusParam as RawStatus)
    : undefined;

  // Incident numbers are only ever digits, letters and dashes ("26-118273",
  // "120047"). Strip anything else so the value can't reshape the PostgREST
  // filter it's spliced into.
  const incidentNo =
    url.searchParams.get("incidentNo")?.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || undefined;

  const messages = await listPagerMessages({ limit, before, beforeHash, q, status, incidentNo });
  return NextResponse.json({ messages });
}
