import { NextResponse } from "next/server";
import { getRecentTestSessions, getTestSessionStats } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/live/test/session/history?limit=20 — Test Session History,
// mirroring /api/live/session/history. Fully separate storage, so this
// list (and everything in it) is invisible to production Dashboard/
// analytics by construction.
export async function GET(req: Request) {
  try {
    const limit = Number(new URL(req.url).searchParams.get("limit")) || 20;
    const sessions = await getRecentTestSessions(limit);
    const stats = await Promise.all(sessions.map((s) => getTestSessionStats(s.id)));
    return NextResponse.json({
      sessions: sessions.map((session, i) => ({ session, stats: stats[i] })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load Test Session History: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
