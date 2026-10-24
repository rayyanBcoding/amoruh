import { NextResponse } from "next/server";
import { getProductDrilldown } from "@/lib/reorder-db";
import { DEFAULT_WINDOW, WINDOWS, type WindowKey } from "@/lib/reorder-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/reorder-intelligence/{productId}?window=… — every LIVE the product
// sold in (units, price, historical cost, profit) plus the current best
// actionable supplier cost for forward-looking context. The supplier cost never
// feeds back into the historical numbers.
export async function GET(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  try {
    const { productId } = await params;
    const param = new URL(req.url).searchParams.get("window");
    const window = (WINDOWS.some((w) => w.key === param) ? param : DEFAULT_WINDOW) as WindowKey;
    return NextResponse.json(await getProductDrilldown(productId, window));
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load this product's history: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
