import { NextResponse } from "next/server";
import { getProducts } from "@/lib/db";
import { quickTextSimilarity } from "@/lib/pricing-matching";
import { searchReferenceProducts, searchUnresolvedOffers } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

const MIN_SCORE = 0.2;
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

  const productResults = products
    .map((p) => ({ product: p, score: quickTextSimilarity(q, `${p.brand} ${p.name} ${p.size}`) }))
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, RESULT_LIMIT)
    .map((r) => ({
      type: "product" as const,
      productId: r.product.id,
      brand: r.product.brand,
      name: r.product.name,
      size: r.product.size,
      sku: r.product.sku,
      score: Math.round(r.score * 100) / 100,
    }));

  const referenceProductResults = referenceProducts
    .filter((rp) => !rp.productId)
    .map((rp) => ({
      type: "reference_product" as const,
      referenceProductId: rp.id,
      brand: rp.brand,
      name: rp.name,
      sizeMl: rp.sizeMl,
      concentration: rp.concentration,
    }));

  const unresolvedOfferResults = unresolvedOffers.map((o) => ({
    type: "unresolved_offer" as const,
    supplierId: o.supplierId,
    supplierName: o.supplierName,
    offerKey: o.offerKey,
    description: o.description,
    brand: o.brand,
    reviewStatus: o.reviewStatus,
  }));

  return NextResponse.json({
    results: [...productResults, ...referenceProductResults, ...unresolvedOfferResults],
  });
}
