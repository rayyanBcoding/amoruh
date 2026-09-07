import { NextResponse } from "next/server";
import { getAllProductIdsWithLots, getLotsWithRemaining } from "@/lib/intake-db";
import { computeWeightedAverageLandedCost } from "@/lib/intake-costing";

export const dynamic = "force-dynamic";

// GET /api/intake/landed-costs — weighted-average landed cost per
// product, for every product that has at least one lot. The regular
// Inventory table reads this instead of Product.cost; a product with no
// entry here has no lot history yet and the caller should fall back to
// Product.cost, shown distinctly as a legacy cost rather than an equal,
// authoritative landed cost.
export async function GET() {
  const productIds = await getAllProductIdsWithLots();

  const entries = await Promise.all(
    productIds.map(async (productId) => {
      const lots = await getLotsWithRemaining(productId);
      const weightedAvgLandedCost = computeWeightedAverageLandedCost(lots);
      const totalRemaining = lots.reduce((sum, l) => sum + l.remaining, 0);
      return [productId, { weightedAvgLandedCost, totalRemaining }] as const;
    })
  );

  const result: Record<string, { weightedAvgLandedCost: number | null; totalRemaining: number }> = {};
  for (const [productId, value] of entries) {
    // Only surface products that actually have remaining stock in a lot —
    // a product whose lots are all fully depleted has no "current" landed
    // cost to report and should fall back to Legacy Cost same as one with
    // no lots at all.
    if (value.weightedAvgLandedCost !== null) {
      result[productId] = value;
    }
  }

  return NextResponse.json(result);
}
