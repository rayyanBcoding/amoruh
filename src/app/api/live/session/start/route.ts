import { NextResponse } from "next/server";
import { startLiveSession } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/session/start { name?, operator? }
//
// SETNX-shaped — see startLiveSession()'s Lua script. If a session is
// already active this resumes it rather than erroring, so two operators
// (or two tabs) racing on START LIVE never end up with two active
// sessions.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name : undefined;
    const operator = typeof body?.operator === "string" ? body.operator : "Unknown";

    const session = await startLiveSession(name, operator);
    broadcastStateChanged("live-session-start");
    return NextResponse.json({ session });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not start Live Session: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
