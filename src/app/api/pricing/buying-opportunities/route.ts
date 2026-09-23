import { NextResponse } from "next/server";
import { getSupplierPriceLeaderboard } from "@/lib/pricing-db";
import type { LeaderboardProductEntry } from "@/lib/pricing-types";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type SortKey = "priceDiffUsd" | "priceDiffPct" | "brand" | "price" | "availability" | "name";

// GET /api/pricing/buying-opportunities — a full, paginated, sortable,
// filterable browse of EVERY eligible competitive product (never a
// curated shortlist), or the single-supplier-only population as a
// separate, clearly labeled view. Reads the SAME cached, freshness-
// verified leaderboard data Supplier Price Leaders uses (never a second
// "best price" computation) and does sort/filter/pagination server-side
// so the response stays small regardless of catalog size.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const view = params.get("view") === "single_supplier" ? "single_supplier" : "competitive";
  const sort = (params.get("sort") as SortKey) || "priceDiffUsd";
  const dir = params.get("dir") === "asc" ? 1 : -1;
  const brand = params.get("brand")?.trim().toLowerCase() || "";
  const productForm = params.get("productForm")?.trim().toLowerCase() || "";
  const priceMin = params.get("priceMin") ? Number(params.get("priceMin")) : null;
  const priceMax = params.get("priceMax") ? Number(params.get("priceMax")) : null;
  const savingsThreshold = params.get("savingsThreshold") ? Number(params.get("savingsThreshold")) : null;
  const carried = params.get("carried"); // "carried" | "not_carried" | null (both)
  const cursor = Number(params.get("cursor") ?? 0);
  const limit = Math.min(Number(params.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);

  const board = await getSupplierPriceLeaderboard();

  if (view === "single_supplier") {
    let items = board.singleSupplierProducts;
    if (brand) items = items.filter((p) => p.brand.toLowerCase().includes(brand));
    if (carried === "carried") items = items.filter((p) => p.isCarried);
    if (carried === "not_carried") items = items.filter((p) => !p.isCarried);
    if (priceMin !== null) items = items.filter((p) => p.priceUsd >= priceMin);
    if (priceMax !== null) items = items.filter((p) => p.priceUsd <= priceMax);
    items = [...items].sort((a, b) => (sort === "brand" || sort === "name" ? a.brand.localeCompare(b.brand) : a.priceUsd - b.priceUsd) * (dir === -1 ? -1 : 1));
    const page = items.slice(cursor, cursor + limit);
    return NextResponse.json({ view, items: page, nextCursor: cursor + limit < items.length ? cursor + limit : null, total: items.length, computedAt: board.computedAt });
  }

  let items: LeaderboardProductEntry[] = board.competitiveProducts;
  if (brand) items = items.filter((p) => p.brand.toLowerCase().includes(brand));
  if (productForm) items = items.filter((p) => p.productForm.toLowerCase() === productForm);
  if (carried === "carried") items = items.filter((p) => p.isCarried);
  if (carried === "not_carried") items = items.filter((p) => !p.isCarried);
  if (priceMin !== null) items = items.filter((p) => p.bestPriceUsd >= priceMin);
  if (priceMax !== null) items = items.filter((p) => p.bestPriceUsd <= priceMax);
  if (savingsThreshold !== null) items = items.filter((p) => (p.perUnitAdvantageUsd ?? 0) >= savingsThreshold);

  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "priceDiffUsd":
        cmp = (a.perUnitAdvantageUsd ?? -1) - (b.perUnitAdvantageUsd ?? -1);
        break;
      case "priceDiffPct":
        cmp = (a.perUnitAdvantagePct ?? -1) - (b.perUnitAdvantagePct ?? -1);
        break;
      case "brand":
        cmp = a.brand.localeCompare(b.brand);
        break;
      case "name":
        cmp = a.name.localeCompare(b.name);
        break;
      case "price":
        cmp = a.bestPriceUsd - b.bestPriceUsd;
        break;
      case "availability":
        cmp = a.eligibleSupplierCount - b.eligibleSupplierCount;
        break;
    }
    return cmp * dir;
  });

  const page = sorted.slice(cursor, cursor + limit);
  return NextResponse.json({
    view,
    items: page,
    nextCursor: cursor + limit < sorted.length ? cursor + limit : null,
    total: sorted.length,
    computedAt: board.computedAt,
  });
}
