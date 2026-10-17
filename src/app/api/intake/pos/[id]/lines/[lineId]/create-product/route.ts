import { NextResponse } from "next/server";
import { createAndLinkProductForLine } from "@/lib/intake-product-linking";
import type { Product } from "@/lib/types";

export const dynamic = "force-dynamic";

// ProductEditorForm posts the product fields at the top level of the body;
// an explicit { product } wrapper is also accepted.
type Body = Partial<Product> & { product?: Partial<Product> };

// POST /api/intake/pos/[id]/lines/[lineId]/create-product
//
// Single-line "Create New Product From Invoice" for a PO that's already
// saved (PO Detail's modal) — create the product AND link it to this PO
// line as one server-side step, using the operator's final (possibly
// edited) field values from the modal. Returns the created/linked
// Product directly on success, or {error} on failure — the exact same
// shape POST /api/products returns, so ProductEditorForm (which drives
// this via its `createUrl` prop) needs no special-casing between the two.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; lineId: string }> }
) {
  const { id, lineId } = await params;
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { product: wrapped, ...topLevel } = body;
  const overrides = wrapped ?? (Object.keys(topLevel).length > 0 ? topLevel : undefined);
  const result = await createAndLinkProductForLine(id, lineId, overrides);

  if (result.status === "failed") {
    // `fields` lets the form highlight the offending inputs (same shape as POST /api/products).
    return NextResponse.json({ error: result.error ?? "Could not create this product.", fields: result.fields }, { status: 400 });
  }

  return NextResponse.json(result.product);
}
