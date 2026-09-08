import { NextResponse } from "next/server";
import { listOpenHazards } from "@/lib/hazard-store";
import { verifyAccessToken } from "@/lib/access";

export const dynamic = "force-dynamic";

// GET /api/hazards -> the open Live Traffic hazards in the brigade's area.
//
// Members only, like the board. There is no POST: hazards arrive from the
// feeder writing straight to Supabase, and nothing about them is worth an
// ingestion endpoint that would also have to be defended.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || (await verifyAccessToken(token)) === null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const hazards = await listOpenHazards();
    return NextResponse.json({ hazards });
  } catch (error) {
    console.error("[hazards] list failed", error);
    return NextResponse.json({ error: "Unable to load hazards" }, { status: 503 });
  }
}
