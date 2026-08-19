import { NextResponse } from "next/server";
import { buildSnapshot, getProduct, getState, patchState } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/state/queue { productId, action: "add" | "remove" }
// Manages the "Coming Up Next" live queue.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const productId = typeof body?.productId === "string" ? body.productId : "";
    const action = body?.action === "remove" ? "remove" : "add";

    const product = await getProduct(productId);
    if (!product) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    const state = await getState();
    const withoutProduct = state.queueIds.filter((id) => id !== productId);
    const queueIds = action === "add" ? [...withoutProduct, productId] : withoutProduct;

    await patchState({ queueIds });
    broadcastStateChanged("queue-updated");
    return NextResponse.json(await buildSnapshot());
  } catch (err) {
    return NextResponse.json(
      { error: `Could not update queue: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
