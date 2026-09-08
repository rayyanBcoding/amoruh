import { NextResponse } from "next/server";
import { getProductOfferComparison } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

// GET /api/pricing/products/[id]/offers — every supplier's current offer
// for one master product, split into actionable (eligible for "Best
// Current Price") vs. everything else shown for context only.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const comparison = await getProductOfferComparison(id);
  return NextResponse.json(comparison);
}
