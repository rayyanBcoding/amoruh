import { NextResponse } from "next/server";
import { redis } from "@/lib/kv";
import { getSuppliers, KEYS as IntakeKeys } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// TEST-ONLY cleanup endpoint for Phase 1A verification. Deletes a
// supplier record and every amoruh:pricing:* key that can reference it
// (uploads, snapshots, generations, aliases, sequence counters) plus the
// offers_by_product sets for the given test product ids. NOT part of
// the shipped feature — removed before merging to main.
//
// Guarded to only ever touch a supplier whose name starts with
// "TEST_PRICING_" as a last-resort safety net against accidentally
// wiping a real supplier's data.
export async function POST(req: Request) {
  let body: { supplierId?: string; productIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }
  const { supplierId, productIds = [] } = body;
  if (!supplierId) return NextResponse.json({ error: "Missing supplierId." }, { status: 400 });

  const suppliers = await getSuppliers();
  const supplier = suppliers.find((s) => s.id === supplierId);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
  if (!supplier.name.startsWith("TEST_PRICING_")) {
    return NextResponse.json({ error: "Refusing to wipe a non-TEST_PRICING_ supplier." }, { status: 400 });
  }

  const deletedKeys: string[] = [];

  // Every upload this supplier ever made -> its snapshot rows.
  const uploadIds = (await redis.zrange(`amoruh:pricing:uploads_by_supplier:${supplierId}`, 0, -1)) as string[];
  for (const uploadId of uploadIds) {
    const snapKeys = await redis.keys(`amoruh:pricing:offer_snapshot:${uploadId}:*`);
    for (const k of snapKeys) await redis.del(k);
    deletedKeys.push(...snapKeys);
    await redis.del(`amoruh:pricing:upload:${uploadId}`);
    deletedKeys.push(`amoruh:pricing:upload:${uploadId}`);
    await redis.zrem("amoruh:pricing:uploads_all", uploadId);
  }
  await redis.del(`amoruh:pricing:uploads_by_supplier:${supplierId}`);

  // Every generation hash this supplier ever had.
  const genKeys = await redis.keys(`amoruh:pricing:offer_current:${supplierId}:*`);
  for (const k of genKeys) await redis.del(k);
  deletedKeys.push(...genKeys);

  const historyKeys = await redis.keys(`amoruh:pricing:offer_history:${supplierId}:*`);
  for (const k of historyKeys) await redis.del(k);
  deletedKeys.push(...historyKeys);

  await Promise.all([
    redis.del(`amoruh:pricing:current_generation_id:${supplierId}`),
    redis.del(`amoruh:pricing:current_generation_seq:${supplierId}`),
    redis.del(`amoruh:pricing:upload_seq:${supplierId}`),
    redis.del(`amoruh:pricing:aliases:${supplierId}`),
  ]);

  for (const productId of productIds) {
    await redis.del(`amoruh:pricing:offers_by_product:${productId}`);
    deletedKeys.push(`amoruh:pricing:offers_by_product:${productId}`);
  }

  const remainingSuppliers = suppliers.filter((s) => s.id !== supplierId);
  await redis.set(IntakeKeys.suppliers, remainingSuppliers);

  return NextResponse.json({ ok: true, deletedKeyCount: deletedKeys.length, uploadsRemoved: uploadIds.length });
}
