import { NextResponse } from "next/server";
import { goLiveRestoreSale } from "@/lib/live-db";
import { broadcastStateChanged } from "@/lib/events";
import { SalesError } from "@/lib/sales-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/restore-sale { saleId, operator?, idempotencyKey } —
// reactivates a canceled order under its original LIVE Order #, decrementing
// inventory again (refused when there isn't enough stock). Idempotent and
// CAS-guarded. See restoreSale() in sales-analytics.ts.
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
    const sale = await goLiveRestoreSale({
      saleId: body.saleId,
      operator: body.operator || "Live Show",
      idempotencyKey: body.idempotencyKey,
    });
    broadcastStateChanged("live-restore-sale");
    return NextResponse.json({ sale });
  } catch (err) {
    const status = err instanceof SalesError ? err.status : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not restore this order." }, { status });
  }
}
