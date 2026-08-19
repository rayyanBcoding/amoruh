import { NextResponse } from "next/server";
import { buildSnapshot, getState, patchState, makeDefaultFlashDeal } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/state/next — advance to the next product in the live queue.
export async function POST() {
  try {
    const state = await getState();
    const [nextId, ...rest] = state.queueIds;

    if (!nextId) {
      return NextResponse.json({ error: "The queue is empty — nothing to advance to." }, { status: 400 });
    }

    await patchState({
      currentProductId: nextId,
      queueIds: rest,
      flashDeal: makeDefaultFlashDeal(),
    });

    broadcastStateChanged("next-product");
    return NextResponse.json(await buildSnapshot());
  } catch (err) {
    return NextResponse.json(
      { error: `Could not advance to next product: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
