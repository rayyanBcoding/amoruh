import { NextResponse } from "next/server";
import { getActiveTestSession, getTestSessionState, patchTestSessionState, resolveSimulatedProduct } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/next — mirrors /api/live/next.
export async function POST() {
  try {
    const session = await getActiveTestSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Test Live." }, { status: 400 });
    }

    const state = await getTestSessionState(session.id);
    const [nextId, ...rest] = state.queueIds;
    if (!nextId) {
      return NextResponse.json({ error: "The queue is empty — nothing to advance to." }, { status: 400 });
    }

    await patchTestSessionState(session.id, { currentProductId: nextId, queueIds: rest });
    await resolveSimulatedProduct(session.id, nextId); // initialize its simulated inventory if not already

    return NextResponse.json({ currentProductId: nextId });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not advance to next product: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
