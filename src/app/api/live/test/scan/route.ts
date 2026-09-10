import { NextResponse } from "next/server";
import { findProductByCode } from "@/lib/db";
import { getActiveTestSession, getTestSessionState, patchTestSessionState, resolveSimulatedProduct } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/scan { barcode } — mirrors /api/live/scan, but
// resolves through resolveSimulatedProduct so the returned product's
// `inventory` is the session's simulated count, not the real one. Does
// NOT shadow-write into the legacy LiveState the way real scan does —
// TV Display's test-mode support reads the test session directly (see
// /api/tv/current), so no compatibility hook is needed here.
export async function POST(req: Request) {
  try {
    const session = await getActiveTestSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Test Live." }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const barcode = typeof body?.barcode === "string" ? body.barcode : "";

    const realProduct = await findProductByCode(barcode);
    if (!realProduct) {
      return NextResponse.json({ error: `No product matches "${barcode}".`, barcode, notFound: true }, { status: 404 });
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
      { error: `Scan failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
