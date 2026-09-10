import { NextResponse } from "next/server";
import { getProduct, getState } from "@/lib/db";
import { getActiveSession, getSessionState } from "@/lib/live-db";
import { getActiveTestSession, getTestSessionState } from "@/lib/test-live-db";
import { toTVProduct } from "@/lib/tv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tv/current — the ONLY data TV Display ever fetches. Returns
// the explicit customer-safe allowlist (see toTVProduct/TVProduct), never
// the full Product object — the pre-Go-Live TV page received the whole
// snapshot (including cost/shelf/notes) over the wire and just didn't
// render them; this route is the actual fix; see the approved plan's TV
// payload finding.
//
// Resolution order: an active real Live's current product wins; only if
// there's no real Live active do we check for an active Test Live (Real
// and Test are mutually exclusive by construction, so this is never
// ambiguous) and mark the payload `isTest: true` — TVStage renders an
// unmissable TEST watermark whenever that's set, so a rehearsal can never
// be mistaken for a real broadcast. Falls back to the legacy global
// LiveState for the transition period (a plain "Mark Sold" outside Go
// Live still sets that).
export async function GET() {
  try {
    const [session, testSession, legacyState] = await Promise.all([getActiveSession(), getActiveTestSession(), getState()]);
    let productId: string | null = null;
    let isTest = false;

    if (session && session.status === "active") {
      const state = await getSessionState(session.id);
      productId = state.currentProductId;
    } else if (testSession && testSession.status === "active") {
      const state = await getTestSessionState(testSession.id);
      productId = state.currentProductId;
      isTest = true;
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
      isTest,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load TV data: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
