import { NextResponse } from "next/server";
import { endLiveSession, setCurrentProductForTV } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/session/end { sessionId }
//
// Idempotent — ending an already-ended session just returns its existing
// record, never a new endedAt. See endLiveSession()'s Lua script for the
// atomic status-flip + active-pointer-clear.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId." }, { status: 400 });
    }

    const session = await endLiveSession(sessionId);
    await setCurrentProductForTV(null);
    broadcastStateChanged("live-session-end");
    return NextResponse.json({ session });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not end Live Session: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
