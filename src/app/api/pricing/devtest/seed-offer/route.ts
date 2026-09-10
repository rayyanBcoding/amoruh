import { NextResponse } from "next/server";
import { redis } from "@/lib/kv";
import { getOrCreateSupplier } from "@/lib/intake-db";
import type { SupplierOfferCurrent } from "@/lib/pricing-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only. Directly commits one SupplierOfferCurrent
// for a TEST_ supplier, bypassing the whole parse/upload/matching
// pipeline (unchanged by this PR — only what happens AFTER an offer
// exists in new_candidate state is being verified here). Removed before
// merging this branch's PR.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const supplierName: string = body?.supplierName;
  const offerKey: string = body?.offerKey;
  const description: string = body?.description ?? "";
  const brand: string = body?.brand ?? "";
  const upc: string = body?.upc ?? "";
  const ean: string = body?.ean ?? "";
  const price: number = Number(body?.price ?? 10);

  if (!supplierName?.startsWith("TEST_")) {
    return NextResponse.json({ error: "supplierName must start with TEST_" }, { status: 400 });
  }
  if (!offerKey) return NextResponse.json({ error: "Missing offerKey." }, { status: 400 });

  const supplier = await getOrCreateSupplier(supplierName);
  const generationId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const offer: SupplierOfferCurrent = {
    supplierId: supplier.id,
    offerKey,
    supplierSku: offerKey,
    description,
    brand,
    quantity: null,
    currency: "USD",
    price,
    fxRateAtUpload: 1,
    fxRateTimestamp: new Date().toISOString(),
    priceUsdAtUpload: price,
    upc,
    ean,
    productId: null,
    candidateProductId: null,
    matchType: "unmatched",
    referenceProductId: null,
    matchConfidence: null,
    reviewStatus: "new_candidate",
    currentlyListed: true,
    lastUploadId: "TEST_UPLOAD",
    uploadedAt: new Date().toISOString(),
  };

  await redis.hset(`amoruh:pricing:offer_current:${supplier.id}:${generationId}`, { [offerKey]: offer });
  await redis.set(`amoruh:pricing:current_generation_id:${supplier.id}`, generationId);
  const currentSeq = (await redis.get<number>(`amoruh:pricing:current_generation_seq:${supplier.id}`)) ?? 0;
  await redis.set(`amoruh:pricing:current_generation_seq:${supplier.id}`, currentSeq + 1);

  return NextResponse.json({ ok: true, supplierId: supplier.id, generationId, offer });
}
