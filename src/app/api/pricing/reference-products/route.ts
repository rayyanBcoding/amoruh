import { NextResponse } from "next/server";
import { getReferenceProducts, searchReferenceProducts } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

// GET /api/pricing/reference-products?q=...&limit=... — search (by
// brand/name/description/UPC/EAN, exact UPC/EAN first) when `q` is
// given; otherwise a plain newest-first page, for the "Link to tracked
// item…" picker and any future browsing UI.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    const limit = Number(url.searchParams.get("limit")) || 50;

    if (q) {
      const items = await searchReferenceProducts(q, limit);
      return NextResponse.json({ items });
    }

    const cursor = Number(url.searchParams.get("cursor")) || 0;
    const { items, nextCursor } = await getReferenceProducts({ limit, cursor });
    return NextResponse.json({ items, nextCursor });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load reference products: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
