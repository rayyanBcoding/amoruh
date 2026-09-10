import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import {
  getActiveSession,
  getPresentationsForSession,
  getProductFinancials,
  getRecentSessions,
  getSellingConfig,
  getSessionStats,
  getSessionState,
} from "@/lib/live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 30;

// GET /api/live/session/active — the one call the Go Live screen needs on
// load/refresh/reconnect to fully restore itself: active session (or
// null), current product + its operator-only financial block, queue,
// recent sales/no-sales, live stats, and the selling-cost config. This is
// what makes a refresh/reconnect mid-session safe (guardrail #11) — all
// of it is server-backed, nothing lives only in React state.
export async function GET() {
  try {
    const session = await getActiveSession();
    const sellingConfig = await getSellingConfig();

    if (!session) {
      const recentSessions = await getRecentSessions(10);
      return NextResponse.json({ session: null, recentSessions, sellingConfig });
    }

    const [state, stats, views] = await Promise.all([
      getSessionState(session.id),
      getSessionStats(session.id),
      getPresentationsForSession(session.id, RECENT_LIMIT),
    ]);

    const [currentProduct, queueProducts] = await Promise.all([
      state.currentProductId ? getProduct(state.currentProductId) : null,
      Promise.all(state.queueIds.map((id) => getProduct(id))),
    ]);

    const currentProductFinancials = currentProduct
      ? await getProductFinancials(currentProduct.id, currentProduct.cost)
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
      sellingConfig,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load the active Live Session: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
