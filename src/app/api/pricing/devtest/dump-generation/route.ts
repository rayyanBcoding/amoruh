import { NextResponse } from "next/server";
import { getCommittedOffers, getCurrentGenerationId, getCurrentGenerationSeq } from "@/lib/pricing-db";
import { redis } from "@/lib/kv";

export const dynamic = "force-dynamic";

// TEMPORARY debug-only route for Phase 1A verification. Deleted before merge.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const supplierId = url.searchParams.get("supplierId");
  const offerKey = url.searchParams.get("offerKey");
  if (!supplierId) return NextResponse.json({ error: "Missing supplierId" }, { status: 400 });

  const generationId = await getCurrentGenerationId(supplierId);
  const seq = await getCurrentGenerationSeq(supplierId);
  const offers = await getCommittedOffers(supplierId);
  const uploadIds = await redis.zrange(`amoruh:pricing:uploads_by_supplier:${supplierId}`, 0, -1, { rev: true });
  const uploads = await Promise.all((uploadIds as string[]).map((id) => redis.get(`amoruh:pricing:upload:${id}`)));

  let historyCount: number | null = null;
  if (offerKey) {
    historyCount = await redis.zcard(`amoruh:pricing:offer_history:${supplierId}:${offerKey}`);
  }

  return NextResponse.json({ generationId, seq, offerKeys: Object.keys(offers), offers, uploads, historyCount });
}

// TEMPORARY: backdate an offer's uploadedAt (both in the committed
// generation and via a synthetic old snapshot) to test the freshness/
// staleness rule without waiting 14 real days. Test-only, removed
// before merge.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { supplierId, offerKey, daysAgo } = body as { supplierId?: string; offerKey?: string; daysAgo?: number };
  if (!supplierId || !offerKey || !daysAgo) {
    return NextResponse.json({ error: "Missing supplierId, offerKey, or daysAgo." }, { status: 400 });
  }
  const generationId = await getCurrentGenerationId(supplierId);
  if (!generationId) return NextResponse.json({ error: "No committed generation." }, { status: 400 });

  const offers = await getCommittedOffers(supplierId);
  const offer = offers[offerKey];
  if (!offer) return NextResponse.json({ error: "Offer not found." }, { status: 404 });

  const backdated = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  await redis.hset(`amoruh:pricing:offer_current:${supplierId}:${generationId}`, {
    [offerKey]: { ...offer, uploadedAt: backdated },
  });
  return NextResponse.json({ ok: true, backdated });
}
