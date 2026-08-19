import { NextResponse } from "next/server";
import { buildSnapshot, getProduct, getState, makeDefaultFlashDeal, patchState } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/state/select { productId } — jump straight to a product, used
// by the dashboard's product search (manual override outside of scanning).
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const productId = typeof body?.productId === "string" ? body.productId : "";

    const product = await getProduct(productId);
    if (!product) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    const state = await getState();
    await patchState({
      currentProductId: product.id,
      queueIds: state.queueIds.filter((id) => id !== product.id),
      flashDeal: makeDefaultFlashDeal(),
    });

    broadcastStateChanged("select-product");
    return NextResponse.json(await buildSnapshot());
  } catch (err) {
    return NextResponse.json(
      { error: `Could not select product: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
