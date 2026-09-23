import { NextResponse } from "next/server";
import { getProducts } from "@/lib/db";
import { quickTextSimilarity } from "@/lib/pricing-matching";
import { searchReferenceProducts, searchUnresolvedOffers, getPriceLeaderboardPreview } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

// Re-tuned from 0.2 -- confirmed too low, a plausible cause of
// "unrelated brands ranked highly" reported against this exact path.
// Matches the floor used by the newly-indexed reference-product and
// unresolved-offer search paths for consistency.
const MIN_SCORE = 0.35;
const RESULT_LIMIT = 20;

// GET /api/pricing/search?q=... — tolerant of misspellings and word
// order (spec §34's "aventis creed" -> "Creed Aventus" example). Plan
// §4: three clearly labeled result types, never presented as if they
// were each other —
//   - "product": a real, physically-carried Product (unchanged from
//     before this change).
//   - "reference_product": a Master Product AMORUH has never stocked. A
//     Master Product already linked to a real Product is deliberately
//     EXCLUDED here — it's represented only by its "product" result,
//     never as a second, separate entry (same linked-pair dedup rule as
//     the matching pool itself).
//   - "unresolved_offer": a still new_candidate/needs_review/conflict
//     supplier offer — "nothing imported should become invisible merely
//     because matching is incomplete."
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  const [products, referenceProducts, unresolvedOffers] = await Promise.all([
    getProducts(),
    searchReferenceProducts(q, RESULT_LIMIT),
    searchUnresolvedOffers(q, RESULT_LIMIT),
  ]);

  // Exact normalized full-name match ranks above any fuzzy score (same
  // exact-match-first rule the indexed reference-product path uses) —
  // "exact full-name search" must never be out-scored by a partial hit.
  const qNormalized = q.trim().toLowerCase();
  const rankedProducts = products
    .map((p) => {
      const nameNormalized = `${p.brand} ${p.name}`.trim().toLowerCase();
      const score = nameNormalized === qNormalized ? 2 : quickTextSimilarity(q, `${p.brand} ${p.name} ${p.size}`);
      return { product: p, score };
    })
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, RESULT_LIMIT);

  const rankedReferenceProducts = referenceProducts.filter((rp) => !rp.productId).slice(0, RESULT_LIMIT);

  // Price preview per result — sourced from the SAME cached, freshness-
  // verified leaderboard computation Supplier Price Leaders/Buying
  // Opportunities use (getPriceLeaderboardPreview does one cheap cache
  // read, not a live comparison call per result). Earlier this called
  // getProductOfferComparison/getReferenceProductOfferComparison per
  // result directly -- confirmed live to take 60+ SECONDS for a single
  // search (each comparison call does its own multi-step Redis round
  // trips), making search far worse than the bug being fixed. Never
  // repeat that mistake here.
  const preview = await getPriceLeaderboardPreview();

  const productResults = rankedProducts.map((r) => {
    const p = preview.byProductId.get(r.product.id);
    return {
      type: "product" as const,
      productId: r.product.id,
      brand: r.product.brand,
      name: r.product.name,
      size: r.product.size,
      sku: r.product.sku,
      score: Math.round(r.score * 100) / 100,
      carried: true,
      bestPriceUsd: p?.bestPriceUsd ?? null,
      eligibleSupplierCount: p?.eligibleSupplierCount ?? 0,
    };
  });

  const referenceProductResults = rankedReferenceProducts.map((rp) => {
    const p = preview.byReferenceProductId.get(rp.id);
    return {
      type: "reference_product" as const,
      referenceProductId: rp.id,
      brand: rp.brand,
      name: rp.name,
      sizeMl: rp.sizeMl,
      concentration: rp.concentration,
      carried: false,
      bestPriceUsd: p?.bestPriceUsd ?? null,
      eligibleSupplierCount: p?.eligibleSupplierCount ?? 0,
    };
  });

  const unresolvedOfferResults = unresolvedOffers.map((o) => ({
    type: "unresolved_offer" as const,
    supplierId: o.supplierId,
    supplierName: o.supplierName,
    offerKey: o.offerKey,
    description: o.description,
    brand: o.brand,
    upc: o.upc,
    supplierSku: o.supplierSku,
    price: o.price,
    currency: o.currency,
    quantity: o.quantity,
    // Computed server-side (never client-side — Date.now() during
    // render is impure/unstable) — freshness, in whole days.
    ageDays: Math.round((Date.now() - new Date(o.uploadedAt).getTime()) / (1000 * 60 * 60 * 24)),
    reviewStatus: o.reviewStatus,
    reviewRequestedAt: o.reviewRequestedAt,
  }));

  return NextResponse.json({
    results: [...productResults, ...referenceProductResults, ...unresolvedOfferResults],
  });
}
