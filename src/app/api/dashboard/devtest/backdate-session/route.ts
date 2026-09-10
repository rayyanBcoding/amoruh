import { NextResponse } from "next/server";
import { redis } from "@/lib/kv";
import type { LiveSession } from "@/lib/live-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only. Overwrites a TEST session's `startedAt`
// field only (never its zset index score) so timeframe-filtering logic
// (which compares LiveSession.startedAt against the cutoff) can be
// exercised without waiting real days — session ORDERING (which reads
// the zset, i.e. real creation time) is untouched, matching how a real
// deployment would never have this mismatch. Removed before merging
// this branch's PR.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const startedAt = typeof body?.startedAt === "string" ? body.startedAt : "";
  if (!sessionId || !sessionId.startsWith("live_")) {
    return NextResponse.json({ error: "Missing/invalid sessionId." }, { status: 400 });
  }
  if (!startedAt) return NextResponse.json({ error: "Missing startedAt." }, { status: 400 });

  const key = `amoruh:live:session:${sessionId}`;
  const session = await redis.get<LiveSession>(key);
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });

  const updated: LiveSession = { ...session, startedAt };
  await redis.set(key, updated);
  return NextResponse.json({ ok: true, session: updated });
}
