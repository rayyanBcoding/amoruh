import { NextResponse } from "next/server";
import { getReferenceProductOfferComparison } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

// GET /api/pricing/reference-products/[id]/offers — every supplier's
// current offer for one Master Product AMORUH has never (yet) stocked,
// split into actionable (eligible for "Current Best Price") vs.
// everything else shown for context only. Direct twin of
// /api/pricing/products/[id]/offers.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const comparison = await getReferenceProductOfferComparison(id);
  return NextResponse.json(comparison);
}
