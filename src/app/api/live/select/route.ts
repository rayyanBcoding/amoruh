import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import { getActiveSession, getSessionState, patchSessionState, setCurrentProductForTV } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/select { productId } — jump straight to a product
// (search result "Load Now"), same effect as a scan.
export async function POST(req: Request) {
  try {
    const session = await getActiveSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Live Session." }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const productId = typeof body?.productId === "string" ? body.productId : "";
    const product = await getProduct(productId);
    if (!product) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    const state = await getSessionState(session.id);
    await patchSessionState(session.id, {
      currentProductId: product.id,
      queueIds: state.queueIds.filter((id) => id !== product.id),
    });
    await setCurrentProductForTV(product.id);

    broadcastStateChanged("live-select");
    return NextResponse.json({ product });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not select product: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
