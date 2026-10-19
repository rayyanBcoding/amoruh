import { NextResponse } from "next/server";
import { goLiveEditSale } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";
import { SalesError } from "@/lib/sales-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/edit-sale { saleId, newPrice?, newQuantity?, newProductId?,
// operator?, idempotencyKey } — corrects an ACTIVE order's price, quantity
// and/or product in one atomic, CAS-guarded step. Inventory, lots, aggregates
// and the append-only audit trail change together or not at all. See
// editSale() in sales-analytics.ts.
export async function POST(req: Request) {
  let body: {
    saleId?: string;
    newPrice?: number;
    newQuantity?: number;
    newProductId?: string;
    operator?: string;
    idempotencyKey?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.idempotencyKey) return NextResponse.json({ error: "Missing idempotencyKey." }, { status: 400 });
  if (typeof body.saleId !== "string" || !body.saleId) return NextResponse.json({ error: "Missing saleId." }, { status: 400 });
  if (body.newPrice !== undefined && typeof body.newPrice !== "number") return NextResponse.json({ error: "newPrice must be a number." }, { status: 400 });
  if (body.newQuantity !== undefined && typeof body.newQuantity !== "number") return NextResponse.json({ error: "newQuantity must be a number." }, { status: 400 });
  if (body.newProductId !== undefined && typeof body.newProductId !== "string") return NextResponse.json({ error: "newProductId must be a string." }, { status: 400 });

  try {
    const sale = await goLiveEditSale({
      saleId: body.saleId,
      newPrice: body.newPrice,
      newQuantity: body.newQuantity,
      newProductId: body.newProductId,
      operator: body.operator || "Live Show",
      idempotencyKey: body.idempotencyKey,
    });
    broadcastStateChanged("live-edit-sale");
    return NextResponse.json({ sale });
  } catch (err) {
    const status = err instanceof SalesError ? err.status : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not edit this order." }, { status });
  }
}
