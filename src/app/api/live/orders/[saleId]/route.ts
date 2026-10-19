import { NextResponse } from "next/server";
import { getOrderDetail } from "@/lib/live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/live/orders/{saleId} — one order with its full audit timeline.
export async function GET(_req: Request, { params }: { params: Promise<{ saleId: string }> }) {
  try {
    const { saleId } = await params;
    const detail = await getOrderDetail(saleId);
    if (!detail) return NextResponse.json({ error: "Order not found." }, { status: 404 });
    return NextResponse.json(detail);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load this order: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
