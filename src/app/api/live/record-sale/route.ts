import { NextResponse } from "next/server";
import { getActiveSession, goLiveRecordSale } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";
import { SalesError } from "@/lib/sales-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/record-sale { productId, quantity?, winningBid,
// operator?, idempotencyKey } — the atomic, multi-lot-safe, session-aware
// sale write. See recordSale() in sales-analytics.ts for the full
// read-plan/verify-at-commit/retry-on-conflict guarantee.
export async function POST(req: Request) {
  let body: {
    productId?: string;
    quantity?: number;
    winningBid?: number;
    operator?: string;
    idempotencyKey?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.idempotencyKey) {
    return NextResponse.json({ error: "Missing idempotencyKey." }, { status: 400 });
  }
  if (typeof body.productId !== "string" || !body.productId) {
    return NextResponse.json({ error: "Missing productId." }, { status: 400 });
  }
  if (typeof body.winningBid !== "number") {
    return NextResponse.json({ error: "Missing winningBid." }, { status: 400 });
  }

  try {
    const session = await getActiveSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Live Session." }, { status: 400 });
    }

    const result = await goLiveRecordSale({
      sessionId: session.id,
      productId: body.productId,
      quantity: body.quantity ?? 1,
      winningBid: body.winningBid,
      operator: body.operator || "Live Show",
      idempotencyKey: body.idempotencyKey,
    });

    broadcastStateChanged("live-record-sale");
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof SalesError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not record sale." },
      { status }
    );
  }
}
