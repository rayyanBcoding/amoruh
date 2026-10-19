import { NextResponse } from "next/server";
import { getActiveSessionId, getSessionOrderLedger, type OrderLedgerStatusFilter } from "@/lib/live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/live/orders?sessionId=&q=&status=all|active|canceled&offset=&limit=
// The complete order ledger of ONE Live Session (the active one when
// sessionId is omitted): search by LIVE Order #, product, SKU or barcode,
// filter by status, newest first, paged. Read-only.
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const sessionId = params.get("sessionId") || (await getActiveSessionId());
    if (!sessionId) {
      return NextResponse.json({ error: "No active Live Session." }, { status: 404 });
    }
    const statusParam = params.get("status");
    const status: OrderLedgerStatusFilter = statusParam === "active" || statusParam === "canceled" ? statusParam : "all";
    const page = await getSessionOrderLedger(sessionId, {
      q: params.get("q") ?? "",
      status,
      offset: Number(params.get("offset")) || 0,
      limit: Number(params.get("limit")) || 50,
    });
    return NextResponse.json(page);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load the order ledger: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
