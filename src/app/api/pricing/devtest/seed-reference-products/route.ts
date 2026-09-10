import { NextResponse } from "next/server";
import { createReferenceProduct } from "@/lib/pricing-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only. Bulk-seeds N reference products (for the
// index-scale/search verification) directly via createReferenceProduct —
// the same function the real "Track for Pricing" action uses. Removed
// before merging this branch's PR.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const count: number = Math.min(500, Number(body?.count) || 0);
  const brandPrefix: string = body?.brandPrefix || "TEST_SCALE";
  if (count <= 0) return NextResponse.json({ error: "Missing/invalid count." }, { status: 400 });

  const created = [];
  for (let i = 0; i < count; i++) {
    const p = await createReferenceProduct({
      brand: brandPrefix,
      name: `Bulk Item ${i}`,
      description: `${brandPrefix} Bulk Item ${i}`,
      sizeMl: null,
      concentration: null,
      isTester: false,
      isGiftSet: false,
      upc: "",
      ean: "",
      createdBy: "devtest",
    });
    created.push(p.id);
  }
  return NextResponse.json({ ok: true, createdIds: created });
}
