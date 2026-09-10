import { NextResponse } from "next/server";
import { endTestLiveSession } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/session/end { sessionId, disposition: "discard" | "keep" }
//
// "keep" always succeeds (ending is essentially infallible). "discard"
// attempts deletion as a separate, distinguishable step — the response's
// `discarded` field is the ONLY thing the UI should trust to say
// "Discarded"; a cleanup failure after a successful end returns
// `discarded: false` with a retry message, never a false success.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const disposition = body?.disposition === "discard" ? "discard" : "keep";
    if (!sessionId) {
      return NextResponse.json({ error: "Missing sessionId." }, { status: 400 });
    }

    const result = await endTestLiveSession(sessionId, disposition);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not end Test Live: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
