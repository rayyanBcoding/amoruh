import { NextResponse } from "next/server";
import { redis } from "@/lib/kv";

export const dynamic = "force-dynamic";

interface Aggregate {
  completedSaleCount: number;
  completedSalesRevenue: number;
}

// GET /api/intake/sales-summary — average sale price + count for every
// product that has at least one completed sale, in one call. Reads only
// the small per-product aggregate keys (never scans SaleRecords) — the
// bulk counterpart to /api/intake/products/[id]/sales-summary, used by
// the Inventory table so it isn't making one request per row.
export async function GET() {
  const keys = await redis.keys("amoruh:sales:aggregate:*");
  const prefix = "amoruh:sales:aggregate:";

  const result: Record<string, { averageSalePrice: number | null; saleCount: number }> = {};
  if (keys.length === 0) return NextResponse.json(result);

  const aggregates = await Promise.all(keys.map((k) => redis.get<Aggregate>(k)));
  keys.forEach((key, i) => {
    const agg = aggregates[i];
    if (!agg || agg.completedSaleCount === 0) return;
    const productId = key.slice(prefix.length);
    result[productId] = {
      averageSalePrice: agg.completedSalesRevenue / agg.completedSaleCount,
      saleCount: agg.completedSaleCount,
    };
  });

  return NextResponse.json(result);
}
