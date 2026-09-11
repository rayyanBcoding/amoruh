import { NextResponse } from "next/server";
import { getLotsWithRemaining } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// GET /api/intake/products/[id]/lots — a product's cost layers, each
// with its live cost breakdown (purchase/freight/landed) and remaining
// quantity (purely transaction-derived — see intake-db.ts). Feeds the
// receiving confirm panel's "existing cost layers" display.
//
// Renamed from [productId] to [id] to match its sibling
// products/[id]/sales-summary — two dynamic segments with different
// names at the same route-tree position is invalid and broke `next dev`
// entirely (silently tolerated by `next build`, but not dev). The URL
// itself is unchanged; only the internal param name moved.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lots = await getLotsWithRemaining(id);
  return NextResponse.json({ lots });
}
