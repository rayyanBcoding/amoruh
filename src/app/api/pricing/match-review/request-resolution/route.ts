import { NextResponse } from "next/server";
import { requestIdentityResolution } from "@/lib/pricing-product-linking";
import { getMatchReviewItemForOffer } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

interface Body {
  supplierId?: string;
  offerKey?: string;
}

// POST /api/pricing/match-review/request-resolution — the shared entry
// point any workflow calls when it needs an exact identity right now
// (today: an operator's explicit "Resolve Now"; later: Add to Order /
// Receiving). See requestIdentityResolution (pricing-product-linking.ts)
// for the full contract: already-resolved offers return immediately
// with no human involvement; still-ambiguous ones get flagged for the
// active queue and the caller gets back the full item to show in a
// focused resolution view.
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.supplierId || !body.offerKey) {
    return NextResponse.json({ error: "Missing supplierId or offerKey." }, { status: 400 });
  }

  const result = await requestIdentityResolution(body.supplierId, body.offerKey);
  if (result.status === "not_found") {
    return NextResponse.json({ error: "This supplier offer no longer exists." }, { status: 404 });
  }
  if (result.status === "resolved") {
    return NextResponse.json({ status: "resolved", productId: result.productId, referenceProductId: result.referenceProductId });
  }

  const item = await getMatchReviewItemForOffer(body.supplierId, body.offerKey);
  return NextResponse.json({ status: "needs_resolution", item });
}
