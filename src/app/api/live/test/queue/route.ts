import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import { getActiveTestSession, getTestSessionState, patchTestSessionState } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/queue { productId, action: "add" | "remove" }
//   or { action: "reorder", queueIds }. Mirrors /api/live/queue.
export async function POST(req: Request) {
  try {
    const session = await getActiveTestSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Test Live." }, { status: 400 });
    }

    const body = await req.json().catch(() => null);

    if (body?.action === "reorder") {
      const queueIds = Array.isArray(body?.queueIds) ? body.queueIds.filter((id: unknown) => typeof id === "string") : null;
      if (!queueIds) {
        return NextResponse.json({ error: "queueIds must be an array of product ids." }, { status: 400 });
      }
      await patchTestSessionState(session.id, { queueIds });
      return NextResponse.json({ queueIds });
    }

    const productId = typeof body?.productId === "string" ? body.productId : "";
    const action = body?.action === "remove" ? "remove" : "add";

    const product = await getProduct(productId);
    if (!product) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    const state = await getTestSessionState(session.id);
    const withoutProduct = state.queueIds.filter((id) => id !== productId);
    const queueIds = action === "add" ? [...withoutProduct, productId] : withoutProduct;

    await patchTestSessionState(session.id, { queueIds });
    return NextResponse.json({ queueIds });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not update queue: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
