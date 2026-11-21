import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { updateCatalogMetadata } from "@/lib/product-metadata-db";
import { retailIdentity, retailReferenceError, type RetailReference } from "@/lib/retail-reference";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store" };
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await verifyAuthToken(req.cookies.get(AUTH_COOKIE_NAME)?.value)) return NextResponse.json({ error: "Not authorized." }, { status: 401, headers });
  if (req.headers.get("origin") !== req.nextUrl.origin) return NextResponse.json({ error: "Same-origin request required." }, { status: 403, headers });
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const result = await updateCatalogMetadata((products) => {
      const p = products.find((p) => p.id === id);
      if (!p) throw new Error("Product not found.");
      if (JSON.stringify(p.retailReference ?? null) !== JSON.stringify(body.expectedReference ?? null)) throw new Error("Retail Reference changed; reload before editing.");
      const r = body.retailReference as RetailReference;
      if (!r || r.identityKey !== retailIdentity(p) || r.concentration !== p.concentration) throw new Error("Product identity changed; reload before editing.");
      const error = retailReferenceError(r, p.brand);
      if (error) throw new Error(error);
      const next = { ...r, manuallyEdited: true };
      return { products: products.map((x) => x.id === id ? { ...x, retailReference: next } : x), result: next };
    });
    broadcastStateChanged("retail-reference-updated");
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json({ error: "Could not save retail reference. Check source, price and date, or reload if the product changed." }, { status: 409, headers });
  }
}
