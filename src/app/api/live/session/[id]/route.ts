import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import { getPresentationsForSession, getSession, getSessionStats } from "@/lib/live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/live/session/{id} — full Session Summary view: identity,
// derived stats, and every presentation (sold/no-sale) with its resolved
// product + linked sale, for "view the complete list of Products
// Presented / Sales / No Sales / Corrections."
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getSession(id);
    if (!session) {
      return NextResponse.json({ error: "Live Session not found." }, { status: 404 });
    }

    const [stats, views] = await Promise.all([getSessionStats(id), getPresentationsForSession(id, 5000)]);

    const productIds = Array.from(new Set(views.map((v) => v.presentation.productId)));
    const products = await Promise.all(productIds.map((pid) => getProduct(pid)));
    const productById = new Map(products.filter((p) => p !== null).map((p) => [p!.id, p!]));

    const items = views.map((v) => ({
      presentation: v.presentation,
      sale: v.sale,
      product: productById.get(v.presentation.productId) ?? null,
    }));

    return NextResponse.json({ session, stats, items });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load this Live Session: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
