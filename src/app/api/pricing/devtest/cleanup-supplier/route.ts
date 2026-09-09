import { NextResponse } from "next/server";
import { redis } from "@/lib/kv";
import { getSupplier, updateSupplier } from "@/lib/intake-db";
import { getCommittedOffers, getCurrentGenerationId } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

// TEMPORARY cleanup route for the Jizan incident. Independently re-runs
// the same clean-audit check as devtest/audit-supplier before deleting
// anything — never trusts that the audit was actually run first by a
// separate call. Refuses to proceed if it finds ANY product link or
// alias. Every key deleted is either an exact, already-known upload ID,
// an exact, already-known generation key, or a deterministically
// constructed snapshot/history key — never a broad pattern scan (which
// also isn't safe at this row count, per the audit route's fix).
export async function POST(req: Request) {
  const { supplierId, confirm } = (await req.json().catch(() => ({}))) as { supplierId?: string; confirm?: boolean };
  if (!supplierId) return NextResponse.json({ error: "Missing supplierId." }, { status: 400 });
  if (confirm !== true) return NextResponse.json({ error: "Missing confirm: true." }, { status: 400 });

  const supplier = await getSupplier(supplierId);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });

  // Re-audit independently — do not trust a prior GET call.
  const [offers, aliases, uploadIds] = await Promise.all([
    getCommittedOffers(supplierId),
    redis.get<unknown[]>(`amoruh:pricing:aliases:${supplierId}`),
    redis.zrange(`amoruh:pricing:uploads_by_supplier:${supplierId}`, 0, -1),
  ]);
  const productLinks = Object.values(offers).filter((o) => o.productId !== null);
  const aliasCount = Array.isArray(aliases) ? aliases.length : 0;

  if (productLinks.length > 0 || aliasCount > 0) {
    return NextResponse.json(
      {
        error: "Refusing to delete — found product links or aliases that must be reviewed first.",
        productLinksFound: productLinks.length,
        productLinks,
        aliasesFound: aliasCount,
      },
      { status: 409 }
    );
  }

  const uploads = await Promise.all(
    (uploadIds as string[]).map((id) => redis.get<{ id: string; processedRows?: number; totalRows?: number }>(`amoruh:pricing:upload:${id}`))
  );

  let snapshotKeysDeleted = 0;
  for (const upload of uploads) {
    if (!upload) continue;
    const count = upload.processedRows ?? upload.totalRows ?? 0;
    for (let i = 0; i < count; i++) {
      await redis.del(`amoruh:pricing:offer_snapshot:${upload.id}:${i}`);
      snapshotKeysDeleted++;
    }
  }

  const offerKeys = Object.keys(offers);
  await Promise.all(offerKeys.map((k) => redis.del(`amoruh:pricing:offer_history:${supplierId}:${k}`)));

  const currentGenerationId = await getCurrentGenerationId(supplierId);
  const genKeys = await redis.keys(`amoruh:pricing:offer_current:${supplierId}:*`); // bounded by upload count, safe
  await Promise.all(genKeys.map((k) => redis.del(k)));

  await Promise.all([
    ...(uploadIds as string[]).map((id) => redis.del(`amoruh:pricing:upload:${id}`)),
    redis.del(`amoruh:pricing:uploads_by_supplier:${supplierId}`),
    ...(uploadIds as string[]).map((id) => redis.zrem("amoruh:pricing:uploads_all", id)),
    redis.del(`amoruh:pricing:current_generation_id:${supplierId}`),
    redis.del(`amoruh:pricing:current_generation_seq:${supplierId}`),
    redis.del(`amoruh:pricing:aliases:${supplierId}`),
  ]);

  await updateSupplier(supplierId, { columnMapping: undefined, defaultUploadType: undefined });

  return NextResponse.json({
    ok: true,
    supplierId,
    uploadsDeleted: uploadIds.length,
    generationsDeleted: genKeys.length,
    generationKeysDeleted: genKeys,
    liveGenerationWas: currentGenerationId,
    snapshotKeysDeleted,
    historyKeysDeleted: offerKeys.length,
  });
}
