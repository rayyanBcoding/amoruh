import { NextResponse } from "next/server";
import { startTestLiveSession } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/session/start { name?, operator? }
//
// Mirrors /api/live/session/start exactly, against the isolated
// amoruh:testlive:* namespace. Refuses (via the shared
// claimActiveSession() atomic check — see live-mode-guard.ts) if a real
// Live is currently active.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name : undefined;
    const operator = typeof body?.operator === "string" ? body.operator : "Unknown";

    const session = await startTestLiveSession(name, operator);
    return NextResponse.json({ session });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not start Test Live: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    );
  }
}
