import { NextResponse } from "next/server";
import { getAllInventoryTransactions, getLotsWithRemaining } from "@/lib/intake-db";
import { getSaleRecordsForProduct, computeAverageSalePrice } from "@/lib/sales-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only, READ-ONLY. Inspects real business data for
// a product so the verification script can prove Test Live Mode never
// touched it. Removed before merging this branch's PR.
export async function GET(req: Request) {
  const productId = new URL(req.url).searchParams.get("productId") || "";
  if (!productId) return NextResponse.json({ error: "Missing productId." }, { status: 400 });

  const [txns, lots, sales, avg] = await Promise.all([
    getAllInventoryTransactions(),
    getLotsWithRemaining(productId),
    getSaleRecordsForProduct(productId, 50),
    computeAverageSalePrice(productId),
  ]);

  const productTxns = txns.filter((t) => t.productId === productId);
  const totalRemaining = lots.reduce((sum, l) => sum + l.remaining, 0);

  return NextResponse.json({
    transactionCount: productTxns.length,
    totalRemaining,
    saleCount: sales.length,
    averageSalePrice: avg.averageSalePrice,
    aggregateSaleCount: avg.saleCount,
  });
}
