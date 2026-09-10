import { NextResponse } from "next/server";
import { goLiveCancelSale } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";
import { SalesError } from "@/lib/sales-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/cancel-sale { saleId, operator?, idempotencyKey } —
// reverses inventory/lot effects, preserves the original SaleRecord
// (status: "canceled"), and updates the durable product-level sales
// aggregate — all atomically, CAS-guarded on both the sale's own version
// AND the product's version. See cancelSale() in sales-analytics.ts.
export async function POST(req: Request) {
  let body: { saleId?: string; operator?: string; idempotencyKey?: string };
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

  try {
    const sale = await goLiveCancelSale({
      saleId: body.saleId,
      operator: body.operator || "Live Show",
      idempotencyKey: body.idempotencyKey,
    });
    broadcastStateChanged("live-cancel-sale");
    return NextResponse.json({ sale });
  } catch (err) {
    const status = err instanceof SalesError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not cancel sale." },
      { status }
    );
  }
}
