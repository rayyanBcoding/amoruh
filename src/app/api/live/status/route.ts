import { NextResponse } from "next/server";
import { getActiveSessionId } from "@/lib/live-db";
import { getActiveTestSessionId } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/live/status — the ONE call /golive/page.tsx makes before
// mounting anything, to decide which mode (if any) is currently active.
// Real and Test are mutually exclusive by construction (see
// claimActiveSession in live-mode-guard.ts), so this is a simple either/
// or/neither, never both.
export async function GET() {
  try {
    const [realId, testId] = await Promise.all([getActiveSessionId(), getActiveTestSessionId()]);
    const mode: "real" | "test" | null = realId ? "real" : testId ? "test" : null;
    return NextResponse.json({ mode });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not check Live status: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
