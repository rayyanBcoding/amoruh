import { NextResponse } from "next/server";
import { getProduct, getState } from "@/lib/db";
import { getActiveSession, getSessionState } from "@/lib/live-db";
import { toTVProduct } from "@/lib/tv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tv/current — the ONLY data TV Display ever fetches. Returns
// the explicit customer-safe allowlist (see toTVProduct/TVProduct), never
// the full Product object — the pre-Go-Live TV page received the whole
// snapshot (including cost/shelf/notes) over the wire and just didn't
// render them; this route is the actual fix; see the approved plan's TV
// payload finding. Prefers Go Live's active-session current product;
// falls back to the legacy global LiveState for the transition period
// (a plain "Mark Sold" session outside Go Live still sets that).
export async function GET() {
  try {
    const [session, legacyState] = await Promise.all([getActiveSession(), getState()]);
    let productId: string | null = null;

    if (session && session.status === "active") {
      const state = await getSessionState(session.id);
      productId = state.currentProductId;
    } else {
      productId = legacyState.currentProductId;
    }

    const product = productId ? await getProduct(productId) : null;
    // Flash Deal is legacy global state (Go Live doesn't set it — no
    // fixed live price in an auction), kept here only so a flash deal
    // toggled through the old Inventory "Mark Sold" flow still shows on
    // TV. Its fields (active/discountPercent) are customer-facing by
    // design, not part of the operator-only financial block.
    return NextResponse.json({
      product: product ? toTVProduct(product) : null,
      flashDeal: legacyState.flashDeal,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load TV data: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
