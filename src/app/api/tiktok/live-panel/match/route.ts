import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import { MatchError } from "@/lib/tiktok/matches";
import { setPanelMatch } from "@/lib/tiktok/live-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/tiktok/live-panel/match { roomId, sellerSku, productId | null }
// Saves (or clears with null) the TikTok-side match (room_id, seller_sku) → AMORUH productId.
// It does NOT create a SaleRecord, change inventory / cost / profit, or write to TikTok.
// Unpaid / cancelled / conflicting auctions are refused.
const noStore = { "cache-control": "no-store" };

export async function POST(req: Request) {
  let b: { roomId?: unknown; sellerSku?: unknown; productId?: unknown };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: noStore });
  }
  if (typeof b.roomId !== "string" || !/^\d+$/.test(b.roomId) || typeof b.sellerSku !== "string" || !b.sellerSku || !(b.productId === null || typeof b.productId === "string")) {
    return NextResponse.json({ error: "roomId, sellerSku and productId (or null) are required." }, { status: 400, headers: noStore });
  }
  try {
    const result = await setPanelMatch(
      { roomId: b.roomId, sellerSku: b.sellerSku, productId: b.productId as string | null },
      { productExists: async (id) => !!(await getProduct(id)) }
    );
    return NextResponse.json(result, { headers: noStore });
  } catch (err) {
    if (err instanceof MatchError) {
      const status = err.code === "SLOT_NOT_FOUND" || err.code === "NOT_FOUND" ? 404 : err.code === "BAD_PRODUCT_ID" ? 400 : 409;
      return NextResponse.json({ error: err.message, code: err.code }, { status, headers: noStore });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save the match." }, { status: 500, headers: noStore });
  }
}
