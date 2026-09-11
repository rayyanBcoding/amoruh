import { NextResponse } from "next/server";
import { linkOfferToReferenceProduct, unlinkOfferReference } from "@/lib/pricing-reference-linking";

export const dynamic = "force-dynamic";

// POST /api/pricing/suppliers/[id]/offers/[offerKey]/link-reference-product
// { referenceProductId } — attach this offer to an EXISTING tracked
// item (e.g. a second supplier's matching listing), for cross-supplier
// price comparison on something you don't carry yet.
//
// DELETE — clears the link back to null (unlink).
export async function POST(req: Request, { params }: { params: Promise<{ id: string; offerKey: string }> }) {
  const { id, offerKey } = await params;
  let body: { referenceProductId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.referenceProductId) {
    return NextResponse.json({ error: "Missing referenceProductId." }, { status: 400 });
  }

  const result = await linkOfferToReferenceProduct(id, decodeURIComponent(offerKey), body.referenceProductId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Could not link this item." }, { status: 400 });
  }
  return NextResponse.json({ ok: true, referenceProduct: result.referenceProduct });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; offerKey: string }> }) {
  const { id, offerKey } = await params;
  const result = await unlinkOfferReference(id, decodeURIComponent(offerKey));
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Could not unlink this item." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
