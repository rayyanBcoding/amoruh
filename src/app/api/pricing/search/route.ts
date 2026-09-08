import { NextResponse } from "next/server";
import { getProducts } from "@/lib/db";
import { quickTextSimilarity } from "@/lib/pricing-matching";

export const dynamic = "force-dynamic";

const MIN_SCORE = 0.2;

// GET /api/pricing/search?q=... — tolerant of misspellings and word
// order (spec §34's "aventis creed" -> "Creed Aventus" example), over
// the master catalog only; each result links to that product's
// comparison screen.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  const products = await getProducts();
  const results = products
    .map((p) => ({ product: p, score: quickTextSimilarity(q, `${p.brand} ${p.name} ${p.size}`) }))
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((r) => ({
      productId: r.product.id,
      brand: r.product.brand,
      name: r.product.name,
      size: r.product.size,
      sku: r.product.sku,
      score: Math.round(r.score * 100) / 100,
    }));

  return NextResponse.json({ results });
}
