import { NextResponse } from "next/server";
import { ignoreOffer, linkOfferToProduct, unlinkOffer } from "@/lib/pricing-product-linking";

export const dynamic = "force-dynamic";

interface Body {
  action?: "link" | "unlink" | "ignore";
  supplierId?: string;
  offerKey?: string;
  productId?: string;
}

// POST /api/pricing/match-review/resolve — YES-LINK / NO-UNLINK / IGNORE
// from the Match Review queue. "Create Product" is its own route (see
// match-review/create-product) since it also creates a master Product.
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.action || !body.supplierId || !body.offerKey) {
    return NextResponse.json({ error: "Missing action, supplierId, or offerKey." }, { status: 400 });
  }

  if (body.action === "link") {
    if (!body.productId) return NextResponse.json({ error: "Missing productId." }, { status: 400 });
    const result = await linkOfferToProduct(body.supplierId, body.offerKey, body.productId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }
  if (body.action === "unlink") {
    const result = await unlinkOffer(body.supplierId, body.offerKey);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }
  if (body.action === "ignore") {
    const result = await ignoreOffer(body.supplierId, body.offerKey);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
