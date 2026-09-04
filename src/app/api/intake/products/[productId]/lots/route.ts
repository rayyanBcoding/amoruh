import { NextResponse } from "next/server";
import { getLotsWithRemaining } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// GET /api/intake/products/[productId]/lots — a product's cost layers,
// each with its live cost breakdown (purchase/freight/landed) and
// remaining quantity (purely transaction-derived — see intake-db.ts).
// Feeds the receiving confirm panel's "existing cost layers" display.
export async function GET(_req: Request, { params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  const lots = await getLotsWithRemaining(productId);
  return NextResponse.json({ lots });
}
