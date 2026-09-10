import { NextResponse } from "next/server";
import { createReferenceProductForOffer } from "@/lib/pricing-reference-linking";

export const dynamic = "force-dynamic";

// POST /api/pricing/suppliers/[id]/offers/[offerKey]/create-reference-product
// { brand, name }
//
// Match Review's "Track for Pricing" action — creates (or, on an exact
// UPC/EAN match, links to) a PricingReferenceProduct. Never touches the
// real Product catalog — see pricing-reference-linking.ts.
export async function POST(req: Request, { params }: { params: Promise<{ id: string; offerKey: string }> }) {
  const { id, offerKey } = await params;
  let body: { brand?: string; name?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.brand?.trim() || !body.name?.trim()) {
    return NextResponse.json({ error: "Brand and name are required." }, { status: 400 });
  }

  const result = await createReferenceProductForOffer(id, decodeURIComponent(offerKey), {
    brand: body.brand,
    name: body.name,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Could not track this item." }, { status: 400 });
  }
  return NextResponse.json({ ok: true, referenceProduct: result.referenceProduct, linkedExisting: result.linkedExisting ?? false });
}
