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
    updatedOffer: {
      ...offer,
      productId,
      candidateProductId: productId,
      matchType: "manual",
      reviewStatus: "confirmed",
      // Resolved — clear any active-review flag automatically.
      reviewRequestedAt: null,
    },
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
    updatedOffer: {
      ...offer,
      productId: null,
      candidateProductId: null,
      matchType: "unmatched",
      reviewStatus: "needs_review",
      // The operator is actively undoing a confirmed match right now —
      // that's a deliberate decision that this item needs a fresh look,
      // so it goes straight into the active queue rather than quietly
      // becoming just another unflagged ambiguous offer.
      reviewRequestedAt: new Date().toISOString(),
    },
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
 *  guess but the row STAYS needs_review — there is no "new_candidate"
 *  limbo to fall back into under the corrected operating model: a
 *  rejected guess doesn't resolve the underlying ambiguity, it just
 *  means "not that one," so the item is still exactly what it was — a
 *  genuine Match Review case an operator can search/link/track
 *  manually. Preserves referenceProductId (a tracked item stays
 *  tracked) and every other field untouched. Never touches
 *  offers_by_product — nothing was ever added there for an unconfirmed
 *  candidate. Records the rejection in rejectedCandidateProductIds so
 *  pricing-process.ts's carry-forward never re-suggests this exact
 *  product for this exact supplier item again, while leaving every
 *  other candidate free to surface normally. */
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
      reviewStatus: "needs_review",
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
    updatedOffer: { ...offer, reviewStatus: "ignored", reviewRequestedAt: null },
    newAliases: await getAliasesForSupplier(supplierId),
    offersByProductOps: [],
  });
  return { ok: true };
}

// ---------------------------------------------------------------------
// Sep 2026 scoping change — a genuinely-ambiguous ("needs_review") offer
// no longer joins the active Match Review queue merely by existing; it
// only becomes actionable once flagged. These two functions are the
// only ways that flag is ever set.
// ---------------------------------------------------------------------

/** Explicit operator action ("Send for Review") — flags an ambiguous
 *  offer as needing a human decision NOW, without changing anything
 *  else about it (reviewStatus/candidates/tracking all untouched). This
 *  is what moves an item from "quietly unresolved, searchable" into the
 *  active Review Required queue. Idempotent — sending an already-
 *  flagged item again is a harmless no-op. Only meaningful for
 *  needs_review: alias_conflict/barcode_conflict are already always
 *  active, and anything else isn't ambiguous at all. */
export async function requestReviewForOffer(supplierId: string, offerKey: string): Promise<{ ok: boolean; error?: string }> {
  const offer = await getCurrentOffer(supplierId, offerKey);
  if (!offer) return { ok: false, error: "This supplier offer no longer exists." };
  if (offer.reviewStatus !== "needs_review") {
    return { ok: false, error: "Only a genuinely ambiguous item can be sent for review this way." };
  }
  if (offer.reviewRequestedAt) return { ok: true };

  await resolveOfferManually({
    supplierId,
    offerKey,
    updatedOffer: { ...offer, reviewRequestedAt: new Date().toISOString() },
    newAliases: await getAliasesForSupplier(supplierId),
    offersByProductOps: [],
  });
  return { ok: true };
}

export type IdentityResolutionResult =
  | { status: "resolved"; productId: string | null; referenceProductId: string | null }
  | { status: "needs_resolution"; supplierId: string; offerKey: string }
  | { status: "not_found" };

/** THE shared entry point for any workflow that needs an exact Master
 *  Product/real-Product identity before it can proceed — "the operator
 *  tries to Add to Order," "the item enters Inventory Intake/Receiving,"
 *  or any future workflow with the same requirement. Neither of those
 *  buying/receiving workflows exists yet in Pricing/Ordering (Phase 2),
 *  so nothing calls this today except requestReviewForOffer's own
 *  explicit "Send for Review" path below it — but this is the one hook
 *  they'll both call once built, so wiring them in later is a single
 *  call, not a new mechanism.
 *
 *  Always re-checks CURRENT state first: if the offer has since
 *  resolved on its own (a later upload supplied a UPC, an operator
 *  already handled it through the normal queue), the caller proceeds
 *  immediately with zero human involvement — "if exact identity is
 *  clear, auto-resolve." Only when it's STILL genuinely ambiguous does
 *  this flag it (exactly like requestReviewForOffer) and tell the
 *  caller to show the focused single-item resolution view for this one
 *  offer instead of proceeding. */
export async function requestIdentityResolution(supplierId: string, offerKey: string): Promise<IdentityResolutionResult> {
  const offer = await getCurrentOffer(supplierId, offerKey);
  if (!offer) return { status: "not_found" };

  if (offer.reviewStatus === "auto_matched" || offer.reviewStatus === "confirmed") {
    return { status: "resolved", productId: offer.productId, referenceProductId: offer.referenceProductId };
  }

  if (offer.reviewStatus === "needs_review" && !offer.reviewRequestedAt) {
    await requestReviewForOffer(supplierId, offerKey);
  }
  // alias_conflict/barcode_conflict are already always-active — nothing
  // extra to flag; either way, still ambiguous, so still needs the
  // focused resolution view.
  return { status: "needs_resolution", supplierId, offerKey };
}
