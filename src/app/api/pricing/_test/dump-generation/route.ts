import { NextResponse } from "next/server";
import { getCommittedOffers, getCurrentGenerationId, getCurrentGenerationSeq } from "@/lib/pricing-db";
import { redis } from "@/lib/kv";

export const dynamic = "force-dynamic";

// TEMPORARY debug-only route for Phase 1A verification. Deleted before merge.
export async function GET(req: Request) {
  const supplierId = new URL(req.url).searchParams.get("supplierId");
  if (!supplierId) return NextResponse.json({ error: "Missing supplierId" }, { status: 400 });

  const generationId = await getCurrentGenerationId(supplierId);
  const seq = await getCurrentGenerationSeq(supplierId);
  const offers = await getCommittedOffers(supplierId);
  const uploadIds = await redis.zrange(`amoruh:pricing:uploads_by_supplier:${supplierId}`, 0, -1, { rev: true });
  const uploads = await Promise.all((uploadIds as string[]).map((id) => redis.get(`amoruh:pricing:upload:${id}`)));

  return NextResponse.json({ generationId, seq, offerKeys: Object.keys(offers), offers, uploads });
}
