import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import { getActiveTestSession, getTestSessionState, patchTestSessionState, resolveSimulatedProduct } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/select { productId } — mirrors /api/live/select.
export async function POST(req: Request) {
  try {
    const session = await getActiveTestSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Test Live." }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const productId = typeof body?.productId === "string" ? body.productId : "";
    const realProduct = await getProduct(productId);
    if (!realProduct) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    const state = await getTestSessionState(session.id);
    await patchTestSessionState(session.id, {
      currentProductId: realProduct.id,
      queueIds: state.queueIds.filter((id) => id !== realProduct.id),
    });

    const product = await resolveSimulatedProduct(session.id, realProduct.id);
    return NextResponse.json({ product });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not select product: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
