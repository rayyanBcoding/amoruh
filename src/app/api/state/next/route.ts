import { NextResponse } from "next/server";
import { buildSnapshot, getState, patchState, makeDefaultFlashDeal } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/state/next — advance to the next product in the live queue.
export async function POST() {
  const state = await getState();
  const [nextId, ...rest] = state.queueIds;

  if (!nextId) {
    return NextResponse.json({ error: "Queue is empty" }, { status: 400 });
  }

  await patchState({
    currentProductId: nextId,
    queueIds: rest,
    flashDeal: makeDefaultFlashDeal(),
  });

  broadcastStateChanged("next-product");
  return NextResponse.json(await buildSnapshot());
}
