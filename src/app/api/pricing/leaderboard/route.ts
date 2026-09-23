import { NextResponse } from "next/server";
import { getSupplierPriceLeaderboard } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

// GET /api/pricing/leaderboard — Supplier Price Leaders summary cards
// (suppliers + totals), or with ?supplierId=X, that supplier's own
// winning-product list for the drill-down table (client-side sort/
// filter over this bounded, already-computed list — same idiom as
// InventoryTable.tsx). Reads through getSupplierPriceLeaderboard, which
// verifies both freshness signals (per-supplier generation seq +
// catalogVersion) before trusting its cache and recomputes synchronously
// if either is stale — never returns knowingly-stale data.
export async function GET(req: Request) {
  const supplierId = new URL(req.url).searchParams.get("supplierId");
  const board = await getSupplierPriceLeaderboard();

  const base = { suppliers: board.suppliers, totals: board.totals, computedAt: board.computedAt };
  if (!supplierId) return NextResponse.json(base);

  const products = board.competitiveProducts.filter((p) => p.winningSupplierIds.includes(supplierId));
  const singleSupplierProducts = board.singleSupplierProducts.filter((p) => p.supplierId === supplierId);
  return NextResponse.json({ ...base, products, singleSupplierProducts });
}
