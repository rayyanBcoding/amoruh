import { NextResponse } from "next/server";
import { getLandedCostByProduct } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// GET /api/intake/landed-costs — weighted-average landed cost per
// product, for every product that has at least one lot. The regular
// Inventory table reads this instead of Product.cost; a product with no
// entry here has no lot history yet and the caller should fall back to
// Product.cost, shown distinctly as a legacy cost rather than an equal,
// authoritative landed cost.
//
// Delegates to the shared getLandedCostByProduct() (intake-db.ts) — same
// logic as before, now also shared with Dashboard's lot-accurate
// Inventory Cost Value. This route's own response shape is unchanged
// (weightedAvgLandedCost/totalRemaining); it just doesn't surface the
// newer totalRemainingValue field that Dashboard needs, since no
// existing caller of this route uses it.
export async function GET() {
  const byProduct = await getLandedCostByProduct();
  const result: Record<string, { weightedAvgLandedCost: number | null; totalRemaining: number }> = {};
  for (const [productId, entry] of Object.entries(byProduct)) {
    result[productId] = { weightedAvgLandedCost: entry.weightedAvgLandedCost, totalRemaining: entry.totalRemaining };
  }
  return NextResponse.json(result);
}
