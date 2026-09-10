import { NextResponse } from "next/server";
import { getActiveSession, goLiveRecordNoSale } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/no-sale { productId, operator?, idempotencyKey } —
// records that this product was presented/auctioned but didn't sell.
// Never touches inventory. The idempotency check and the presentation
// write happen in ONE script — see recordNoSale() in sales-analytics.ts.
export async function POST(req: Request) {
  let body: { productId?: string; operator?: string; idempotencyKey?: string };
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

  try {
    const session = await getActiveSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Live Session." }, { status: 400 });
    }

    const result = await goLiveRecordNoSale({
      sessionId: session.id,
      productId: body.productId,
      operator: body.operator || "Live Show",
      idempotencyKey: body.idempotencyKey,
    });

    broadcastStateChanged("live-no-sale");
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not record No Sale." },
      { status: 500 }
    );
  }
}
