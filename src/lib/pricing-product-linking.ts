import { getProducts } from "./db";
import { getCurrentOffer, getAliasesForSupplier, newId, resolveOfferManually } from "./pricing-db";

// ---------------------------------------------------------------------
// Match Review's REAL-catalog LINKING actions — link to an existing
// product you already carry, unlink, or ignore. Each is one small
// resolveOfferManually call (offer field + alias list +
// offers_by_product index, all together). Pricing/Ordering deliberately
// has NO path here (or anywhere else) that creates a new real Product —
// see pricing-reference-linking.ts for "Track for Pricing" / "Link to
// tracked item," which create/link a PricingReferenceProduct instead. A
// real Product is only ever created by Inventory Intake receiving or an
// intentional manual "Add Product" for stock actually owned.
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

/** "No — Not a Match": rejects ONLY the currently-suggested candidate on
 *  a needs_review row — distinct from unlinkOffer (undoes an already-
 *  CONFIRMED link) and from ignoreOffer (dismisses the whole supplier
 *  item). By construction a needs_review offer never has a real
 *  productId yet (matchSupplierRow only ever sets candidateProductId for
 *  this bucket) — refuse if it does, since that means it's actually
 *  confirmed and unlinkOffer is the right action instead. Clears the
 *  guess and returns the row to a clean new_candidate, preserving
 *  referenceProductId (a tracked item stays tracked) and every other
 *  field untouched. Never touches offers_by_product — nothing was ever
 *  added there for an unconfirmed candidate. Records the rejection in
 *  rejectedCandidateProductIds so pricing-process.ts's carry-forward
 *  never re-suggests this exact product for this exact supplier item
 *  again, while leaving every other candidate free to surface normally. */
export async function rejectSuggestedCandidate(
  supplierId: string,
  offerKey: string,
  rejectedProductId: string
): Promise<{ ok: boolean; error?: string }> {
  const offer = await getCurrentOffer(supplierId, offerKey);
  if (!offer) return { ok: false, error: "This supplier offer no longer exists." };
  if (offer.productId) {
    return { ok: false, error: "This offer is already linked to a product — use unlink instead." };
  }

  const rejectedSet = new Set(offer.rejectedCandidateProductIds ?? []);
  rejectedSet.add(rejectedProductId);

  await resolveOfferManually({
    supplierId,
    offerKey,
    updatedOffer: {
      ...offer,
      candidateProductId: null,
      matchType: "unmatched",
      matchConfidence: null,
      reviewStatus: "new_candidate",
      rejectedCandidateProductIds: [...rejectedSet],
    },
    newAliases: await getAliasesForSupplier(supplierId),
    offersByProductOps: [],
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
