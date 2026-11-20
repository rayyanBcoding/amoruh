import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { getProducts } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "private, no-store", "vary": "Cookie" };

// Temporary internal export. The site passcode proxy also protects this route.
// Explicit projection only: never spread Product or export free-form internal notes.
export async function GET(req: NextRequest) {
  if (!(await verifyAuthToken(req.cookies.get(AUTH_COOKIE_NAME)?.value))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401, headers });
  }
  try {
    const products = (await getProducts())
      .filter((p) => Number.isFinite(p.inventory) && p.inventory > 0)
      .map((p) => ({
        productId: p.id,
        brand: p.brand,
        productName: p.name,
        concentration: p.concentration,
        size: p.size,
        condition: p.condition,
        stockQuantity: p.inventory,
        barcode: p.barcode || null,
        sku: p.sku || null,
        // There is no structured gift-set contents field in the current model.
        // Product names may contain contents; do not infer them from internal notes.
        giftSetContents: null,
      }));
    return NextResponse.json({
      exportedAt: new Date().toISOString(),
      count: products.length,
      giftSetContentsNote: "No structured set contents are stored; check productName or verify manually.",
      products,
    }, { headers: { ...headers, "content-disposition": 'attachment; filename="amoruh-in-stock-catalog.json"' } });
  } catch {
    // Do not expose Redis configuration or internal error details in the download.
    return NextResponse.json({ error: "Could not export inventory." }, { status: 500, headers });
  }
}
