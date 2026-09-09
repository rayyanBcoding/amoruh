import { NextResponse } from "next/server";
import { redis } from "@/lib/kv";
import { getProducts } from "@/lib/db";
import { getSupplier } from "@/lib/intake-db";
import { getCommittedOffers, getCurrentGenerationId, getCurrentGenerationSeq } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

// TEMPORARY, READ-ONLY audit route for the Jizan cleanup incident.
// Makes NO writes of any kind. Reports every possible legitimate link
// (non-null productId in the current generation, aliases, offers_by_product
// membership) before any deletion route is allowed to run. Removed after use.
export async function GET(req: Request) {
  const supplierId = new URL(req.url).searchParams.get("supplierId");
  if (!supplierId) return NextResponse.json({ error: "Missing supplierId" }, { status: 400 });

  const supplier = await getSupplier(supplierId);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });

  const [generationId, seq, offers, aliases, products, uploadIds] = await Promise.all([
    getCurrentGenerationId(supplierId),
    getCurrentGenerationSeq(supplierId),
    getCommittedOffers(supplierId),
    redis.get(`amoruh:pricing:aliases:${supplierId}`),
    getProducts(),
    redis.zrange(`amoruh:pricing:uploads_by_supplier:${supplierId}`, 0, -1),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const offerEntries = Object.entries(offers);
  const linked = offerEntries.filter(([, o]) => o.productId !== null);

  const productLinks = await Promise.all(
    linked.map(async ([offerKey, o]) => {
      const product = o.productId ? productById.get(o.productId) : undefined;
      const setMembers = o.productId
        ? ((await redis.smembers(`amoruh:pricing:offers_by_product:${o.productId}`)) as string[])
        : [];
      return {
        offerKey,
        productId: o.productId,
        reviewStatus: o.reviewStatus,
        matchType: o.matchType,
        productFound: Boolean(product),
        productSku: product?.sku ?? null,
        productBrand: product?.brand ?? null,
        productName: product?.name ?? null,
        offersByProductHasMember: setMembers.includes(`${supplierId}::${offerKey}`),
      };
    })
  );

  const uploads = await Promise.all(
    (uploadIds as string[]).map((id) => redis.get(`amoruh:pricing:upload:${id}`))
  );

  let totalSnapshotKeys = 0;
  for (const id of uploadIds as string[]) {
    const keys = await redis.keys(`amoruh:pricing:offer_snapshot:${id}:*`);
    totalSnapshotKeys += keys.length;
  }

  const genKeys = await redis.keys(`amoruh:pricing:offer_current:${supplierId}:*`);
  const historyKeys = await redis.keys(`amoruh:pricing:offer_history:${supplierId}:*`);

  const isClean = productLinks.length === 0 && !aliases;

  return NextResponse.json({
    supplier: { id: supplier.id, name: supplier.name, createdAt: supplier.createdAt },
    dryRun: {
      uploadsToRemove: uploadIds.length,
      uploadIds,
      generationsToRemove: genKeys.length,
      generationKeys: genKeys,
      snapshotsToRemove: totalSnapshotKeys,
      historyKeysToRemove: historyKeys.length,
      productLinksFound: productLinks.length,
      productLinks,
      aliasesFound: aliases ? (aliases as unknown[]).length : 0,
      aliases,
      isClean,
    },
    currentGeneration: { generationId, seq, totalOffers: offerEntries.length },
    uploads,
  });
}
