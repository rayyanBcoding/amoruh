import { NextResponse } from "next/server";
import { getActiveSession, getSessionState, patchSessionState, setCurrentProductForTV } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/next — advance to the next queued product. Does NOT
// resolve a presentation for whatever was current before this — an
// unresolved item simply stops being current (see the LivePresentation
// doc comment on presentation timing).
export async function POST() {
  try {
    const session = await getActiveSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Live Session." }, { status: 400 });
    }

    const state = await getSessionState(session.id);
    const [nextId, ...rest] = state.queueIds;
    if (!nextId) {
      return NextResponse.json({ error: "The queue is empty — nothing to advance to." }, { status: 400 });
    }

    await patchSessionState(session.id, { currentProductId: nextId, queueIds: rest });
    await setCurrentProductForTV(nextId);

    broadcastStateChanged("live-next");
    return NextResponse.json({ currentProductId: nextId });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not advance to next product: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
