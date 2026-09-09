import { NextResponse } from "next/server";
import { redis } from "@/lib/kv";
import { getSuppliers, KEYS as IntakeKeys } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// TEMPORARY, guarded to TEST_PRICING_ suppliers only. Safe to use
// redis.keys() here — this is small, isolated synthetic test data
// (tens of records), nowhere near the row-count scale that broke KEYS
// scanning for the real Jizan cleanup. Removed after use.
export async function POST(req: Request) {
  const { supplierId } = (await req.json().catch(() => ({}))) as { supplierId?: string };
  if (!supplierId) return NextResponse.json({ error: "Missing supplierId" }, { status: 400 });

  const suppliers = await getSuppliers();
  const supplier = suppliers.find((s) => s.id === supplierId);
  if (!supplier) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!supplier.name.startsWith("TEST_PRICING_")) {
    return NextResponse.json({ error: "Refusing to wipe a non-TEST_PRICING_ supplier." }, { status: 400 });
  }

  const uploadIds = (await redis.zrange(`amoruh:pricing:uploads_by_supplier:${supplierId}`, 0, -1)) as string[];
  for (const id of uploadIds) {
    const snapKeys = await redis.keys(`amoruh:pricing:offer_snapshot:${id}:*`);
    for (const k of snapKeys) await redis.del(k);
    await redis.del(`amoruh:pricing:upload:${id}`);
    await redis.zrem("amoruh:pricing:uploads_all", id);
  }
  await redis.del(`amoruh:pricing:uploads_by_supplier:${supplierId}`);

  const genKeys = await redis.keys(`amoruh:pricing:offer_current:${supplierId}:*`);
  for (const k of genKeys) await redis.del(k);
  const historyKeys = await redis.keys(`amoruh:pricing:offer_history:${supplierId}:*`);
  for (const k of historyKeys) await redis.del(k);

  await Promise.all([
    redis.del(`amoruh:pricing:current_generation_id:${supplierId}`),
    redis.del(`amoruh:pricing:current_generation_seq:${supplierId}`),
    redis.del(`amoruh:pricing:upload_seq:${supplierId}`),
    redis.del(`amoruh:pricing:aliases:${supplierId}`),
  ]);

  const remaining = suppliers.filter((s) => s.id !== supplierId);
  await redis.set(IntakeKeys.suppliers, remaining);

  return NextResponse.json({ ok: true, uploadsDeleted: uploadIds.length, generationsDeleted: genKeys.length, historyKeysDeleted: historyKeys.length });
}
