import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import {
  getActiveTestSession,
  getPresentationsForTestSession,
  getRecentTestSessions,
  getTestProductFinancials,
  getTestSessionState,
  getTestSessionStats,
  resolveSimulatedProduct,
} from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 30;

// GET /api/live/test/session/active — mirrors /api/live/session/active's
// response shape (session/currentProduct/currentProductFinancials/queue/
// recent/stats) so the SAME frontend components render regardless of
// mode. Deliberately omits `sellingConfig` — the Break-Even settings
// panel writes to the real, shared selling config, so it only renders in
// real mode (see the page-level `mode === "real"` check); Break-Even
// itself still reads that shared config read-only for display, via
// getTestProductFinancials.
export async function GET() {
  try {
    const session = await getActiveTestSession();

    if (!session) {
      const recentSessions = await getRecentTestSessions(10);
      return NextResponse.json({ session: null, recentSessions });
    }

    const [state, stats, views] = await Promise.all([
      getTestSessionState(session.id),
      getTestSessionStats(session.id),
      getPresentationsForTestSession(session.id, RECENT_LIMIT),
    ]);

    // Current product / queue are resolved through resolveSimulatedProduct
    // so their `inventory` field always reflects the SIMULATED count, not
    // a fresh real read.
    const [currentProduct, queueProducts] = await Promise.all([
      state.currentProductId ? resolveSimulatedProduct(session.id, state.currentProductId) : null,
      Promise.all(state.queueIds.map((id) => getProduct(id))), // queue display doesn't need simulated qty until loaded
    ]);

    const currentProductFinancials = currentProduct
      ? await getTestProductFinancials(session.id, currentProduct.id, currentProduct.cost)
      : null;

    const recentProductIds = Array.from(new Set(views.map((v) => v.presentation.productId)));
    const recentProducts = await Promise.all(recentProductIds.map((id) => getProduct(id)));
    const productById = new Map(recentProducts.filter((p) => p !== null).map((p) => [p!.id, p!]));

    const recent = views.map((v) => ({
      presentation: v.presentation,
      sale: v.sale,
      product: productById.get(v.presentation.productId) ?? null,
    }));

    return NextResponse.json({
      session,
      currentProduct,
      currentProductFinancials,
      queue: queueProducts.filter((p) => p !== null),
      recent,
      stats,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load the active Test Live: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
