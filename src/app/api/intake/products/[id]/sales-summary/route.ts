import { NextResponse } from "next/server";
import { computeAverageSalePrice } from "@/lib/sales-analytics";

export const dynamic = "force-dynamic";

// GET /api/intake/products/[id]/sales-summary — average sale price +
// count for one product. Reads only the small per-product aggregate key
// (see sales-analytics.ts), never scans historical SaleRecords.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const summary = await computeAverageSalePrice(id);
  return NextResponse.json(summary);
}
