// Pricing / Ordering — Phase 1A domain types.
//
// Additive to the existing catalog/Intake model. Supplier offers attach
// to the existing Product (src/lib/types.ts) — there is no parallel
// "MasterProduct" table. See src/lib/pricing-db.ts for the
// generation/commit storage model these types are read/written through.

export type ReviewStatus =
  | "auto_matched"
  | "needs_review"
  | "new_candidate"
  | "alias_conflict"
  | "barcode_conflict"
  | "confirmed"
  | "ignored";

export type OfferMatchType =
  | "alias"
  | "upc"
  | "ean"
  | "structured"
  | "manual"
  | "unmatched";

/** One row from one supplier upload, as originally received — the
 *  supplier's own words, untouched. */
export interface SupplierRawRow {
  supplierSku: string;
  description: string;
  brand: string;
  quantity: number | null;
  price: number;
  currency: string;
  upc: string;
  ean: string;
  category: string;
}

/** The permanent, immutable history record for one row of one upload.
 *  Never overwritten, never deleted — see pricing-db.ts's deterministic
 *  key (amoruh:pricing:offer_snapshot:{uploadId}:{rowIndex}), which is
 *  what makes retrying a failed upload safe against duplicate history. */
export interface SupplierOfferSnapshot {
  id: string;
  uploadId: string;
  rowIndex: number;
  supplierId: string;
  offerKey: string;
  raw: SupplierRawRow;
  productId: string | null;
  /** Best-guess product for review states where productId is null (needs
   *  review / new candidate / alias conflict / barcode conflict) — shown
   *  for a fast one-click confirm, never auto-applied. */
  candidateProductId: string | null;
  matchType: OfferMatchType;
  matchConfidence: number | null;
  reviewStatus: ReviewStatus;
  /** A Pricing/Ordering-only tracked item this offer has been linked to
   *  for cross-supplier price comparison — see PricingReferenceProduct.
   *  Completely independent of productId/reviewStatus: an offer can be
   *  "new_candidate" (genuinely not in the real Inventory catalog) AND
   *  have a referenceProductId at the same time. Never a real Product;
   *  Pricing/Ordering can no longer create one from an unmatched
   *  listing. */
  referenceProductId: string | null;
  /** Original currency + price, never overwritten (rule #4). */
  currency: string;
  price: number;
  /** Captured once, permanently, at upload time — the historical rate,
   *  distinct from the live "comparison FX" computed at read time. */
  fxRateAtUpload: number | null;
  fxRateTimestamp: string | null;
  priceUsdAtUpload: number | null;
  uploadedAt: string;
}

/** The current, comparison-ready state of one supplier's offer for one
 *  offerKey — one field inside that supplier's CURRENT GENERATION hash
 *  (amoruh:pricing:offer_current:{supplierId}:{generationId}), never a
 *  freestanding mutable key. See pricing-db.ts for why. */
export interface SupplierOfferCurrent {
  supplierId: string;
  offerKey: string;
  supplierSku: string;
  description: string;
  brand: string;
  quantity: number | null;
  currency: string;
  price: number;
  fxRateAtUpload: number | null;
  fxRateTimestamp: string | null;
  priceUsdAtUpload: number | null;
  upc: string;
  ean: string;
  productId: string | null;
  candidateProductId: string | null;
  matchType: OfferMatchType;
  matchConfidence: number | null;
  reviewStatus: ReviewStatus;
  /** See the identical field on SupplierOfferSnapshot — carried forward
   *  copy-forward-style across every re-upload of this offerKey, same as
   *  productId, so re-uploading a supplier's sheet never silently wipes
   *  out a tracked link an operator set. */
  referenceProductId: string | null;
  /** false once a FULL upload completes without this offerKey present.
   *  Never deleted — kept for "No Longer Listed" display + history. */
  currentlyListed: boolean;
  /** uploadId that most recently wrote this field (for audit/debugging —
   *  NOT the ordering mechanism itself, which lives on the generation). */
  lastUploadId: string;
  uploadedAt: string;
}

export type UploadStatus = "processing" | "completed" | "failed";

export interface SupplierPriceUpload {
  id: string;
  supplierId: string;
  filename: string;
  blobUrl: string;
  uploadType: "full" | "partial";
  status: UploadStatus;
  /** Assigned at creation time (start order) — this is the ordering
   *  guard the commit script checks; NOT necessarily completion order. */
  seq: number;
  totalRows: number;
  processedRows: number;
  autoMatched: number;
  needsReview: number;
  newCandidates: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

/** Permanent, per-supplier memory: "this supplier's SKU/description =
 *  this Product." Stored as one small array per supplier
 *  (amoruh:pricing:aliases:{supplierId}) — matches the existing
 *  per-entity-blob convention (e.g. poLines(poId)). */
export interface SupplierAlias {
  id: string;
  supplierId: string;
  /** Matched against supplierSku first when present, else the
   *  normalized description — see offerKey derivation in pricing-db.ts. */
  offerKey: string;
  productId: string;
  createdAt: string;
  /** How this alias was created — surfaced for audit ("learned from
   *  Match Review on Sep 7" vs. an automatic high-confidence match). */
  source: "match_review" | "auto_high_confidence";
}

/** Read-shaped view for the Match Review queue UI — derived from a
 *  SupplierOfferCurrent, not a separately stored type. */
export interface MatchReviewItem {
  supplierId: string;
  supplierName: string;
  offerKey: string;
  description: string;
  brand: string;
  price: number;
  currency: string;
  quantity: number | null;
  upc: string;
  reviewStatus: ReviewStatus;
  matchConfidence: number | null;
  /** Best-guess candidate for a one-click confirm — never auto-applied. */
  candidateProductId: string | null;
  candidateLabel: string | null;
  referenceProductId: string | null;
}

/** The three operational buckets a CURRENTLY LISTED offer can fall
 *  into — a delisted offer (currentlyListed: false) is excluded from
 *  all of them entirely, see getMatchReviewSummary. */
export type MatchReviewBucket = "review_required" | "new_candidates" | "matched";

export interface MatchReviewSupplierBreakdown {
  supplierId: string;
  supplierName: string;
  currentlyListed: number;
  noLongerListed: number;
  matched: number;
  reviewRequired: number;
  newCandidates: number;
  /** Sub-split of newCandidates by whether an operator has already
   *  attached a PricingReferenceProduct — a tracked item has been
   *  reviewed and organized, so it shouldn't inflate "still need
   *  attention." newCandidatesUntracked + newCandidatesTracked ===
   *  newCandidates always. */
  newCandidatesUntracked: number;
  newCandidatesTracked: number;
  ignored: number;
}

export interface MatchReviewSummary {
  matched: number;
  reviewRequired: number;
  newCandidates: number;
  newCandidatesUntracked: number;
  newCandidatesTracked: number;
  ignored: number;
  bySupplier: MatchReviewSupplierBreakdown[];
}

/** A Pricing/Ordering-only tracked item — lets an operator name/price-
 *  compare something across suppliers without ever creating a real
 *  Inventory Product. Never read by Dashboard, Go Live, Inventory, or TV;
 *  a real Product is only ever created by Inventory Intake receiving or
 *  an intentional manual "Add Product" for stock actually owned. Carries
 *  the same structured identity the matching engine extracts for real
 *  products (see extractAttributes in pricing-matching.ts) so it's ready
 *  for cross-supplier comparison without another migration later — auto-
 *  matching against these is NOT built this pass; linking is manual. */
export interface PricingReferenceProduct {
  id: string;
  brand: string;
  name: string;
  description: string;
  sizeMl: number | null;
  concentration: string | null;
  isTester: boolean;
  isGiftSet: boolean;
  upc: string;
  ean: string;
  createdAt: string;
  createdBy: string;
}

/** One master product's current price comparison across every supplier
 *  that currently (or previously) listed it. */
export interface ProductOfferComparison {
  productId: string;
  actionable: OfferComparisonRow[];
  nonActionable: OfferComparisonRow[];
  bestPrice: OfferComparisonRow | null;
}

export interface OfferComparisonRow {
  supplierId: string;
  supplierName: string;
  offerKey: string;
  price: number;
  currency: string;
  priceUsd: number;
  currentlyListed: boolean;
  quantity: number | null;
  isStale: boolean;
  ageDays: number;
  uploadedAt: string;
  reviewStatus: ReviewStatus;
}
