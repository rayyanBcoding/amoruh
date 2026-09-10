import { NextResponse } from "next/server";
import { correctTestSalePrice } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/correct-sale { saleId, newPrice, operator?,
// idempotencyKey } — mirrors /api/live/correct-sale.
export async function POST(req: Request) {
  let body: { saleId?: string; newPrice?: number; operator?: string; idempotencyKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.idempotencyKey) return NextResponse.json({ error: "Missing idempotencyKey." }, { status: 400 });
  if (typeof body.saleId !== "string" || !body.saleId) return NextResponse.json({ error: "Missing saleId." }, { status: 400 });
  if (typeof body.newPrice !== "number") return NextResponse.json({ error: "Missing newPrice." }, { status: 400 });

  try {
    const sale = await correctTestSalePrice(body.saleId, body.newPrice, body.operator || "Test Rehearsal", body.idempotencyKey);
    return NextResponse.json({ sale });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not correct test sale." },
      { status: 400 }
    );
  }
}
