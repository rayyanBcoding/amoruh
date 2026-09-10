import { NextResponse } from "next/server";
import { goLiveCorrectSalePrice } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";
import { SalesError } from "@/lib/sales-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/correct-sale { saleId, newPrice, operator?,
// idempotencyKey } — preserves the original bid, sets the corrected
// value as the effective price everywhere, and adjusts the durable
// aggregate by the delta. CAS-guarded on the sale's own version so two
// different corrections racing on the same sale can't both compute their
// delta off the same stale price. See correctSalePrice() in
// sales-analytics.ts.
export async function POST(req: Request) {
  let body: { saleId?: string; newPrice?: number; operator?: string; idempotencyKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.idempotencyKey) {
    return NextResponse.json({ error: "Missing idempotencyKey." }, { status: 400 });
  }
  if (typeof body.saleId !== "string" || !body.saleId) {
    return NextResponse.json({ error: "Missing saleId." }, { status: 400 });
  }
  if (typeof body.newPrice !== "number") {
    return NextResponse.json({ error: "Missing newPrice." }, { status: 400 });
  }

  try {
    const sale = await goLiveCorrectSalePrice({
      saleId: body.saleId,
      newPrice: body.newPrice,
      operator: body.operator || "Live Show",
      idempotencyKey: body.idempotencyKey,
    });
    broadcastStateChanged("live-correct-sale");
    return NextResponse.json({ sale });
  } catch (err) {
    const status = err instanceof SalesError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not correct sale." },
      { status }
    );
  }
}
