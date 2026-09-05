import { NextResponse } from "next/server";
import { createProduct, ValidationError } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";
import type { Product } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/products/bulk { products: Partial<Product>[] }
//
// Pre-save Review-screen bulk create only (Upload Invoice / PO's "Create
// N New Products" for the pre-save flow — see CreateProductModal / the
// Phase-2.5 plan). There's no PO row to orphan from at this point: the
// PO itself isn't created until the final "Create Purchase Order" click
// persists the whole resolved[] array in one go. For a PO that already
// exists, see /api/intake/pos/[id]/bulk-create-products instead, which
// creates AND links each product to its PO line as one atomic step.
//
// Each item is created independently via the same createProduct() every
// other create path uses — one bad item (e.g. an accidental duplicate
// SKU within the same invoice) doesn't abort the rest of the batch.
export async function POST(req: Request) {
  let body: { products?: Partial<Product>[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!Array.isArray(body.products)) {
    return NextResponse.json({ error: "products must be an array." }, { status: 400 });
  }

  const results: ({ ok: true; product: Product } | { ok: false; error: string })[] = [];
  for (const input of body.products) {
    try {
      const product = await createProduct(input);
      results.push({ ok: true, product });
    } catch (err) {
      const error = err instanceof ValidationError ? err.message : err instanceof Error ? err.message : "Could not create this product.";
      results.push({ ok: false, error });
    }
  }

  if (results.some((r) => r.ok)) {
    broadcastStateChanged("bulk-product-create");
  }

  return NextResponse.json({ results });
}
