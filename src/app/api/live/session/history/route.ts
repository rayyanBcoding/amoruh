import { NextResponse } from "next/server";
import { getRecentSessions, getSessionStats } from "@/lib/live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/live/session/history?limit=20 — Live History list: session
// identity + its derived stats, newest first. Nothing here is a stored
// running total; getSessionStats() recomputes fresh from that session's
// own (small, bounded) presentation/sale records every time.
export async function GET(req: Request) {
  try {
    const limit = Number(new URL(req.url).searchParams.get("limit")) || 20;
    const sessions = await getRecentSessions(limit);
    const stats = await Promise.all(sessions.map((s) => getSessionStats(s.id)));
    return NextResponse.json({
      sessions: sessions.map((session, i) => ({ session, stats: stats[i] })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load Live History: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
