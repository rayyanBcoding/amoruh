import { NextResponse } from "next/server";
import { findProductByCode } from "@/lib/db";
import { getActiveSession, patchSessionState, getSessionState, setCurrentProductForTV } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/scan { barcode } — scan/load a known product straight
// into Current Product, no confirmation step (speed is the point). Does
// NOT count as a presentation — see the LivePresentation doc comment;
// only RECORD SALE / NO SALE create one.
export async function POST(req: Request) {
  try {
    const session = await getActiveSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Live Session." }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const barcode = typeof body?.barcode === "string" ? body.barcode : "";

    const product = await findProductByCode(barcode);
    if (!product) {
      return NextResponse.json({ error: `No product matches "${barcode}".`, barcode, notFound: true }, { status: 404 });
    }

    const state = await getSessionState(session.id);
    await patchSessionState(session.id, {
      currentProductId: product.id,
      queueIds: state.queueIds.filter((id) => id !== product.id),
    });
    await setCurrentProductForTV(product.id);

    broadcastStateChanged("live-scan");
    return NextResponse.json({ product });
  } catch (err) {
    return NextResponse.json(
      { error: `Scan failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
