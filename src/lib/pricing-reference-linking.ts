import {
  backfillOfferByReferenceProduct,
  createReferenceProduct,
  getAliasesForSupplier,
  getCurrentOffer,
  getReferenceProduct,
  getReferenceProductByEan,
  getReferenceProductByUpc,
  resolveOfferManually,
  type OffersByReferenceProductOp,
} from "./pricing-db";
import { extractAttributes, isPlausibleBarcode, checkManualLinkCompatibility, type ManualLinkCompatibility } from "./pricing-matching";
import type { PricingReferenceProduct } from "./pricing-types";

// ---------------------------------------------------------------------
// Match Review's "Track for Pricing" / "Link to tracked item" actions —
// the ONLY way a PricingReferenceProduct gets attached to a supplier
// offer. Deliberately never imports createProduct/updateProduct or
// anything from pricing-product-linking.ts: no code path from this file
// can ever reach the real Product catalog. Real-catalog linking
// (Search Another Product / Yes-Link) stays exactly where it is, in
// pricing-product-linking.ts, for the case you already carry the item.
// ---------------------------------------------------------------------

export interface CreateReferenceProductInput {
  brand: string;
  name: string;
  description?: string;
}

export interface ReferenceLinkResult {
  ok: boolean;
  error?: string;
  referenceProduct?: PricingReferenceProduct;
  /** True when an existing reference product (matched by UPC/EAN) was
   *  linked instead of creating a duplicate — surface this to the
   *  operator rather than silently doing either. */
  linkedExisting?: boolean;
  /** Set instead of proceeding when linkOfferToReferenceProduct finds a
   *  brand/size/concentration/form/tester/giftSet/refill/barcode/name
   *  mismatch and the caller didn't pass confirmOverride — ok is false,
   *  nothing was linked, and the caller must show these warnings and
   *  re-call with confirmOverride: true to proceed. Never silently
   *  assigns confidence 1 on an incompatible pair without this step. */
  requiresConfirmation?: ManualLinkCompatibility;
}

async function applyReferenceLink(
  supplierId: string,
  offerKey: string,
  referenceProductId: string | null
): Promise<{ ok: boolean; error?: string }> {
  const offer = await getCurrentOffer(supplierId, offerKey);
  if (!offer) return { ok: false, error: "This supplier offer no longer exists." };

  // resolveOfferManually's `newAliases` is an UNCONDITIONAL full
  // overwrite of the supplier's entire alias list (see RESOLVE_OFFER_
  // SCRIPT in pricing-db.ts) — passing anything other than the
  // supplier's actual current aliases here would silently destroy every
  // real-product alias that supplier has ever had. This action never
  // touches aliases, so it must pass them through completely unchanged.
  const currentAliases = await getAliasesForSupplier(supplierId);

  // Reverse-index maintenance — mirrors the identical SADD/SREM pattern
  // already used by pricing-process.ts's upload-commit path and by
  // linkOfferToProduct/unlinkOffer's real-Product equivalent
  // (pricing-product-linking.ts). THIS WAS THE BUG: this function
  // previously never issued these ops at all, so offers_by_reference_
  // product stayed empty for any link made through "Track for Pricing" /
  // "Resolve Now" / "Link tracked item" — SupplierOfferCurrent.
  // referenceProductId was set correctly, but the comparison page reads
  // exclusively from this reverse index (getOffersByReferenceProduct),
  // so it showed nothing at all until the supplier's NEXT price upload
  // happened to reconcile it via pricing-process.ts's own logic.
  const member = `${supplierId}::${offerKey}`;
  const priorReferenceProductId = offer.referenceProductId ?? null;
  const offersByReferenceProductOps: OffersByReferenceProductOp[] = [];
  if (priorReferenceProductId && priorReferenceProductId !== referenceProductId) {
    offersByReferenceProductOps.push({ op: "SREM", referenceProductId: priorReferenceProductId, member });
  }
  if (referenceProductId && priorReferenceProductId !== referenceProductId) {
    offersByReferenceProductOps.push({ op: "SADD", referenceProductId, member });
  }

  // matchType/reviewStatus now mirror linkOfferToProduct/unlinkOffer's
  // real-Product equivalent exactly: a manual link is a genuine
  // confirmation (an operator directly said "this offer is this exact
  // Master Product"), at least as authoritative as an auto_matched
  // structural match, and requestIdentityResolution ("Resolve Now")
  // already checks for reviewStatus === "confirmed" to treat an offer
  // as already resolved — leaving it at "needs_review" left both that
  // re-entrancy check AND the comparison page's own actionability
  // filter treating a manually-confirmed link as if nothing had
  // happened. Unlinking mirrors unlinkOffer: back to needs_review with
  // reviewRequestedAt set, since the operator is deliberately flagging
  // this item needs a fresh look, not silently going back to quiet
  // ambiguity.
  await resolveOfferManually({
    supplierId,
    offerKey,
    updatedOffer: referenceProductId
      ? { ...offer, referenceProductId, matchType: "manual", reviewStatus: "confirmed", reviewRequestedAt: null }
      : { ...offer, referenceProductId: null, matchType: "unmatched", reviewStatus: "needs_review", reviewRequestedAt: new Date().toISOString() },
    newAliases: currentAliases,
    offersByProductOps: [],
    offersByReferenceProductOps,
  });
  return { ok: true };
}

export async function createReferenceProductForOffer(
  supplierId: string,
  offerKey: string,
  input: CreateReferenceProductInput
): Promise<ReferenceLinkResult> {
  const offer = await getCurrentOffer(supplierId, offerKey);
  if (!offer) return { ok: false, error: "This supplier offer no longer exists." };

  // Retry safety — a genuine network retry (client timeout, double
  // click before the UI re-renders and hides the button) must never
  // create a SECOND Master Product for an offer that's already linked.
  // Without this check, a retried call would fall through to the
  // create-new branch below (nothing there re-checks offer state),
  // leaving the FIRST reference product permanently orphaned — the
  // offer's own referenceProductId now points at the second one, and
  // applyReferenceLink's SREM correctly empties the first one's reverse-
  // index set, but the orphaned record itself lingers in the catalog
  // forever. Returning the already-linked product is a safe no-op —
  // and, defensively, self-heals the exact class of gap this whole bug
  // was: re-adding the reverse-index membership in case this retry is
  // itself recovering from a partial failure (or from before
  // applyReferenceLink was fixed to maintain this index at all).
  // Idempotent either way — a no-op if the membership is already there.
  if (offer.referenceProductId) {
    const alreadyLinked = await getReferenceProduct(offer.referenceProductId);
    if (alreadyLinked) {
      await backfillOfferByReferenceProduct(offer.referenceProductId, supplierId, offerKey);
      return { ok: true, referenceProduct: alreadyLinked, linkedExisting: true };
    }
    // The offer points at a reference product that no longer exists
    // (should not happen in practice — reference products are never
    // deleted — but fall through to normal creation rather than silently
    // succeeding with stale, wrong data).
  }

  // A supplier's own placeholder text ("NO BARCODE" etc.) is never a
  // real, uniquely-shared identifier — treated as absent here exactly
  // like everywhere else upc/ean is used for matching/identity.
  const rawUpc = offer.upc?.trim() ?? "";
  const rawEan = offer.ean?.trim() ?? "";
  const upc = isPlausibleBarcode(rawUpc.toUpperCase()) ? rawUpc : "";
  const ean = isPlausibleBarcode(rawEan.toUpperCase()) ? rawEan : "";

  // Duplicate prevention — an exact UPC/EAN match links to the existing
  // reference product instead of creating a near-duplicate.
  const existing = (upc && (await getReferenceProductByUpc(upc))) || (ean && (await getReferenceProductByEan(ean)));
  if (existing) {
    const result = await applyReferenceLink(supplierId, offerKey, existing.id);
    if (!result.ok) return result;
    return { ok: true, referenceProduct: existing, linkedExisting: true };
  }

  const brand = input.brand.trim();
  const name = input.name.trim();
  const description = input.description?.trim() || offer.description;
  const attrs = extractAttributes(`${brand} ${description}`, brand);

  const referenceProduct = await createReferenceProduct({
    brand,
    name,
    description,
    sizeMl: attrs.sizeMl,
    concentration: attrs.concentration,
    isTester: attrs.isTester,
    isGiftSet: attrs.isGiftSet,
    isRefill: attrs.isRefill,
    productForm: attrs.productForm,
    upc,
    ean,
    productId: null,
    createdBy: "match_review",
    // Manually created via "Track for Pricing" — never auto-import, and
    // provenance still records exactly which offer/supplier prompted it,
    // same as the auto-created path's audit trail.
    creationMethod: "manual_track",
    createdFromSupplierId: supplierId,
    createdFromUploadId: null,
    createdFromOfferKey: offerKey,
  });

  const result = await applyReferenceLink(supplierId, offerKey, referenceProduct.id);
  if (!result.ok) return result;
  return { ok: true, referenceProduct };
}

/** The "Link to tracked item" search-and-pick action — an operator can
 *  choose ANY existing Master Product here, unlike every other link path
 *  in this file (which only ever links via an exact UPC/EAN match).
 *  Confirmed root cause of a real incident: a Dior Homme offer was
 *  manually linked to the Miss Dior Master Product, with no warning and
 *  confidence set to 1. Every pick now runs checkManualLinkCompatibility
 *  first (the same field-by-field check the rest of the matcher already
 *  uses) — a clean pick proceeds exactly as before; an incompatible one
 *  is refused with the specific warnings UNLESS the caller explicitly
 *  passes confirmOverride: true, which is how a genuine override (the
 *  reason this action exists at all) still gets through. */
export async function linkOfferToReferenceProduct(
  supplierId: string,
  offerKey: string,
  referenceProductId: string,
  confirmOverride = false
): Promise<ReferenceLinkResult> {
  const referenceProduct = await getReferenceProduct(referenceProductId);
  if (!referenceProduct) return { ok: false, error: "That tracked item no longer exists." };

  if (!confirmOverride) {
    const offer = await getCurrentOffer(supplierId, offerKey);
    if (!offer) return { ok: false, error: "This supplier offer no longer exists." };
    const offerAttrs = extractAttributes(`${offer.brand} ${offer.description}`, offer.brand);
    const targetAttrs = extractAttributes(`${referenceProduct.brand} ${referenceProduct.description}`, referenceProduct.brand);
    const compatibility = checkManualLinkCompatibility(
      { attrs: offerAttrs, upc: offer.upc, ean: offer.ean },
      { attrs: targetAttrs, upc: referenceProduct.upc, ean: referenceProduct.ean }
    );
    if (!compatibility.compatible) {
      return { ok: false, requiresConfirmation: compatibility };
    }
  }

  const result = await applyReferenceLink(supplierId, offerKey, referenceProductId);
  if (!result.ok) return result;
  return { ok: true, referenceProduct };
}

export async function unlinkOfferReference(supplierId: string, offerKey: string): Promise<{ ok: boolean; error?: string }> {
  return applyReferenceLink(supplierId, offerKey, null);
}
