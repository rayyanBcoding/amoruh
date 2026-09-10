import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import { getActiveSession, getSessionState, patchSessionState } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/queue { productId, action: "add" | "remove" }
//   or { action: "reorder", queueIds: string[] } — the operator dragged
//   the queue into a new order; the full new id list is the simplest safe
//   shape for a short (dozens-of-items) list, and this state was never
//   meant to need conflict detection (see patchSessionState's doc comment).
export async function POST(req: Request) {
  try {
    const session = await getActiveSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Live Session." }, { status: 400 });
    }

    const body = await req.json().catch(() => null);

    if (body?.action === "reorder") {
      const queueIds = Array.isArray(body?.queueIds) ? body.queueIds.filter((id: unknown) => typeof id === "string") : null;
      if (!queueIds) {
        return NextResponse.json({ error: "queueIds must be an array of product ids." }, { status: 400 });
      }
      await patchSessionState(session.id, { queueIds });
      broadcastStateChanged("live-queue-reorder");
      return NextResponse.json({ queueIds });
    }

    const productId = typeof body?.productId === "string" ? body.productId : "";
    const action = body?.action === "remove" ? "remove" : "add";

    const product = await getProduct(productId);
    if (!product) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    const state = await getSessionState(session.id);
    const withoutProduct = state.queueIds.filter((id) => id !== productId);
    const queueIds = action === "add" ? [...withoutProduct, productId] : withoutProduct;

    await patchSessionState(session.id, { queueIds });
    broadcastStateChanged("live-queue");
    return NextResponse.json({ queueIds });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not update queue: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
