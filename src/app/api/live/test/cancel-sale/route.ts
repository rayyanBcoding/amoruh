import { NextResponse } from "next/server";
import { cancelTestSale } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/cancel-sale { saleId, operator?, idempotencyKey } —
// mirrors /api/live/cancel-sale. Restores only this test session's
// simulated inventory — real inventory was never touched by the test
// sale in the first place, so there's nothing real to restore.
export async function POST(req: Request) {
  let body: { saleId?: string; operator?: string; idempotencyKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.idempotencyKey) return NextResponse.json({ error: "Missing idempotencyKey." }, { status: 400 });
  if (typeof body.saleId !== "string" || !body.saleId) return NextResponse.json({ error: "Missing saleId." }, { status: 400 });

  try {
    const sale = await cancelTestSale(body.saleId, body.operator || "Test Rehearsal", body.idempotencyKey);
    return NextResponse.json({ sale });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not cancel test sale." },
      { status: 400 }
    );
  }
}
