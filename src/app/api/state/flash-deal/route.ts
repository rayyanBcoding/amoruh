import { NextResponse } from "next/server";
import { buildSnapshot, getState, patchState } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/state/flash-deal — toggle a flash discount on the current
// product. Body: { discountPercent?: number }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const state = await getState();
  const willActivate = !state.flashDeal.active;

  await patchState({
    flashDeal: {
      active: willActivate,
      discountPercent:
        typeof body?.discountPercent === "number"
          ? body.discountPercent
          : state.flashDeal.discountPercent || 20,
      startedAt: willActivate ? new Date().toISOString() : null,
    },
  });

  broadcastStateChanged("flash-deal");
  return NextResponse.json(await buildSnapshot());
}
