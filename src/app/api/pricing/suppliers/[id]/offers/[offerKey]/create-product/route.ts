import { NextResponse } from "next/server";
import { createAndLinkProductForOffer } from "@/lib/pricing-product-linking";
import type { Product } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST /api/pricing/suppliers/[id]/offers/[offerKey]/create-product
//
// Match Review's "Create Product" action — create the master Product AND
// link this supplier offer to it as one server-side step, mirroring
// Order Intake's createAndLinkProductForLine. ProductEditorForm (via
// CreateProductModal's `createUrl`) posts the raw, possibly-edited
// Partial<Product> body directly (not wrapped) and expects the created
// Product back directly on success — matching every other create-product
// path in this app (plain POST /api/products included).
export async function POST(req: Request, { params }: { params: Promise<{ id: string; offerKey: string }> }) {
  const { id, offerKey } = await params;
  let body: Partial<Product> = {};
  try {
    body = await req.json();
  } catch {
    // An empty body (no edits made) is fine — fall through with defaults.
  }

  const result = await createAndLinkProductForOffer(id, decodeURIComponent(offerKey), body);
  if (result.status === "failed") {
    return NextResponse.json({ error: result.error ?? "Could not create this product." }, { status: 400 });
  }
  return NextResponse.json(result.product);
}
