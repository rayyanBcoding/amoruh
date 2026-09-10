import { NextResponse } from "next/server";
import { getActiveTestSession, recordTestSale } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/record-sale { productId, quantity?, winningBid,
// operator?, idempotencyKey } — mirrors /api/live/record-sale. See
// recordTestSale() in test-live-db.ts: only ever touches this test
// session's own simulated-inventory map, never Product.inventory, never
// InventoryLot/InventoryTransaction, never a production SaleRecord.
export async function POST(req: Request) {
  let body: { productId?: string; quantity?: number; winningBid?: number; operator?: string; idempotencyKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.idempotencyKey) return NextResponse.json({ error: "Missing idempotencyKey." }, { status: 400 });
  if (typeof body.productId !== "string" || !body.productId) return NextResponse.json({ error: "Missing productId." }, { status: 400 });
  if (typeof body.winningBid !== "number") return NextResponse.json({ error: "Missing winningBid." }, { status: 400 });

  try {
    const session = await getActiveTestSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Test Live." }, { status: 400 });
    }

    const result = await recordTestSale({
      sessionId: session.id,
      productId: body.productId,
      quantity: body.quantity ?? 1,
      winningBid: body.winningBid,
      operator: body.operator || "Test Rehearsal",
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not record test sale." },
      { status: 400 }
    );
  }
}
