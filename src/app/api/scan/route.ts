import { NextResponse } from "next/server";
import { buildSnapshot, findProductByCode, getState, patchState } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/scan { barcode: string }
//
// The single endpoint that powers "one barcode scan controls the whole
// workflow": look the code up against SKU/barcode (manufacturer UPC or
// AMORUH internal SKU — both are matched), make it the current product,
// drop it out of the upcoming queue if it was sitting there, and broadcast
// so every open Dashboard / TV tab updates with no refresh.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const barcode = typeof body?.barcode === "string" ? body.barcode : "";

    const product = await findProductByCode(barcode);
    if (!product) {
      return NextResponse.json(
        { error: `No product matches "${barcode}".`, barcode, notFound: true },
        { status: 404 }
      );
    }

    const state = await getState();
    await patchState({
      currentProductId: product.id,
      queueIds: state.queueIds.filter((id) => id !== product.id),
      flashDeal: { active: false, discountPercent: state.flashDeal.discountPercent, startedAt: null },
    });

    broadcastStateChanged("scan");

    const snapshot = await buildSnapshot();
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json(
      { error: `Scan failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
