import {
  createReferenceProduct,
  getAliasesForSupplier,
  getCurrentOffer,
  getReferenceProduct,
  getReferenceProductByEan,
  getReferenceProductByUpc,
  resolveOfferManually,
} from "./pricing-db";
import { extractAttributes } from "./pricing-matching";
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

  // Only referenceProductId changes — productId/candidateProductId/
  // matchType/reviewStatus are untouched, and offersByProductOps stays
  // empty: this never touches the real-catalog reverse index, because
  // it never touches the real catalog.
  await resolveOfferManually({
    supplierId,
    offerKey,
    updatedOffer: { ...offer, referenceProductId },
    newAliases: currentAliases,
    offersByProductOps: [],
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

  const upc = offer.upc?.trim() ?? "";
  const ean = offer.ean?.trim() ?? "";

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
    upc,
    ean,
    createdBy: "match_review",
  });

  const result = await applyReferenceLink(supplierId, offerKey, referenceProduct.id);
  if (!result.ok) return result;
  return { ok: true, referenceProduct };
}

export async function linkOfferToReferenceProduct(
  supplierId: string,
  offerKey: string,
  referenceProductId: string
): Promise<ReferenceLinkResult> {
  const referenceProduct = await getReferenceProduct(referenceProductId);
  if (!referenceProduct) return { ok: false, error: "That tracked item no longer exists." };
  const result = await applyReferenceLink(supplierId, offerKey, referenceProductId);
  if (!result.ok) return result;
  return { ok: true, referenceProduct };
}

export async function unlinkOfferReference(supplierId: string, offerKey: string): Promise<{ ok: boolean; error?: string }> {
  return applyReferenceLink(supplierId, offerKey, null);
}
