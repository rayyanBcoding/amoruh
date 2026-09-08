import { createProduct, getProducts } from "./db";
import { getCurrentOffer, getAliasesForSupplier, newId, resolveOfferManually } from "./pricing-db";
import type { Product } from "./types";
import type { SupplierAlias } from "./pricing-types";

// ---------------------------------------------------------------------
// Server-side create-and-link for Match Review's "Create Product"
// action — mirrors intake-product-linking.ts's createAndLinkProductForLine
// exactly: create the product, force inventory: 0, then link + write the
// alias, all in one request, so there's never a "created but not linked"
// gap. This is the createUrl CreateProductModal's Save button points at.
// ---------------------------------------------------------------------

export interface CreateAndLinkOfferResult {
  status: "created" | "linked_existing" | "failed";
  productId?: string;
  product?: Product;
  error?: string;
}

export async function createAndLinkProductForOffer(
  supplierId: string,
  offerKey: string,
  productOverrides?: Partial<Product>
): Promise<CreateAndLinkOfferResult> {
  const offer = await getCurrentOffer(supplierId, offerKey);
  if (!offer) return { status: "failed", error: "This supplier offer no longer exists." };

  // Already resolved — a retry/double-click is a no-op, same idempotent-
  // by-revalidation shape as the Intake version.
  if (offer.productId) {
    const products = await getProducts();
    const product = products.find((p) => p.id === offer.productId);
    if (product) return { status: "linked_existing", productId: product.id, product };
  }

  const products = await getProducts();
  const upc = (productOverrides?.barcode ?? offer.upc ?? offer.ean ?? "").trim();
  const fallbackSku = `NEW-${offerKey.replace(/[^a-zA-Z0-9]/g, "").slice(-8).toUpperCase()}`;
  const candidateSku = (productOverrides?.sku ?? upc ?? fallbackSku).trim();
  const candidateBarcode = (productOverrides?.barcode ?? upc ?? candidateSku).trim();

  const exactMatch = products.find(
    (p) =>
      (candidateBarcode && p.barcode.toUpperCase() === candidateBarcode.toUpperCase()) ||
      p.sku.toUpperCase() === candidateSku.toUpperCase()
  );

  let product: Product;
  if (exactMatch) {
    product = exactMatch;
  } else {
    const spec: Partial<Product> = {
      sku: candidateSku,
      barcode: candidateBarcode,
      brand: offer.brand,
      name: offer.description,
      description: offer.description,
      cost: offer.price,
      status: "draft",
      ...productOverrides,
      // Creating the master catalog record must never add inventory —
      // that only ever happens through Order Intake receiving.
      inventory: 0,
    };
    try {
      product = await createProduct(spec);
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : "Could not create this product." };
    }
  }

  const existingAliases = await getAliasesForSupplier(supplierId);
  const alreadyAliased = existingAliases.some((a) => a.offerKey === offerKey && a.productId === product.id);
  const newAliases: SupplierAlias[] = alreadyAliased
    ? existingAliases
    : [
        ...existingAliases,
        {
          id: newId("alias"),
          supplierId,
          offerKey,
          productId: product.id,
          createdAt: new Date().toISOString(),
          source: "match_review",
        },
      ];

  await resolveOfferManually({
    supplierId,
    offerKey,
    updatedOffer: { ...offer, productId: product.id, candidateProductId: product.id, matchType: "manual", reviewStatus: "confirmed" },
    newAliases,
    offersByProductOps: [{ op: "SADD", productId: product.id, member: `${supplierId}::${offerKey}` }],
  });

  return { status: exactMatch ? "linked_existing" : "created", productId: product.id, product };
}

// ---------------------------------------------------------------------
// Match Review's other actions — link to an existing product, unlink,
// ignore. Each is one small resolveOfferManually call (offer field +
// alias list + offers_by_product index, all together).
// ---------------------------------------------------------------------

export async function linkOfferToProduct(
  supplierId: string,
  offerKey: string,
  productId: string
): Promise<{ ok: boolean; error?: string }> {
  const [offer, products] = await Promise.all([getCurrentOffer(supplierId, offerKey), getProducts()]);
  if (!offer) return { ok: false, error: "This supplier offer no longer exists." };
  if (!products.some((p) => p.id === productId)) return { ok: false, error: "That product no longer exists." };

  const existingAliases = await getAliasesForSupplier(supplierId);
  const alreadyAliased = existingAliases.some((a) => a.offerKey === offerKey && a.productId === productId);
  const newAliases = alreadyAliased
    ? existingAliases
    : [
        ...existingAliases,
        { id: newId("alias"), supplierId, offerKey, productId, createdAt: new Date().toISOString(), source: "match_review" as const },
      ];

  const ops = offer.productId && offer.productId !== productId
    ? [
        { op: "SREM" as const, productId: offer.productId, member: `${supplierId}::${offerKey}` },
        { op: "SADD" as const, productId, member: `${supplierId}::${offerKey}` },
      ]
    : [{ op: "SADD" as const, productId, member: `${supplierId}::${offerKey}` }];

  await resolveOfferManually({
    supplierId,
    offerKey,
    updatedOffer: { ...offer, productId, candidateProductId: productId, matchType: "manual", reviewStatus: "confirmed" },
    newAliases,
    offersByProductOps: ops,
  });
  return { ok: true };
}

/** Clears a match AND removes the learned alias for this offerKey so it
 *  doesn't silently re-fire on the next upload — per spec §4, unlinking
 *  an incorrect match must be a real, durable correction. */
export async function unlinkOffer(supplierId: string, offerKey: string): Promise<{ ok: boolean; error?: string }> {
  const offer = await getCurrentOffer(supplierId, offerKey);
  if (!offer) return { ok: false, error: "This supplier offer no longer exists." };

  const existingAliases = await getAliasesForSupplier(supplierId);
  const newAliases = existingAliases.filter((a) => a.offerKey !== offerKey);

  const ops = offer.productId
    ? [{ op: "SREM" as const, productId: offer.productId, member: `${supplierId}::${offerKey}` }]
    : [];

  await resolveOfferManually({
    supplierId,
    offerKey,
    updatedOffer: { ...offer, productId: null, candidateProductId: null, matchType: "unmatched", reviewStatus: "needs_review" },
    newAliases,
    offersByProductOps: ops,
  });
  return { ok: true };
}

/** Marks a listing as "not one of our products" so Match Review stops
 *  asking about it on every future upload — e.g. accessories/boxes on a
 *  supplier's sheet that will never become a master Product. */
export async function ignoreOffer(supplierId: string, offerKey: string): Promise<{ ok: boolean; error?: string }> {
  const offer = await getCurrentOffer(supplierId, offerKey);
  if (!offer) return { ok: false, error: "This supplier offer no longer exists." };

  await resolveOfferManually({
    supplierId,
    offerKey,
    updatedOffer: { ...offer, reviewStatus: "ignored" },
    newAliases: await getAliasesForSupplier(supplierId),
    offersByProductOps: [],
  });
  return { ok: true };
}
