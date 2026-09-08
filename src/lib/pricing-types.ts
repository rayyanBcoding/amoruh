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
  upc: string;
  reviewStatus: ReviewStatus;
  matchConfidence: number | null;
  /** Best-guess candidate for a one-click confirm — never auto-applied. */
  candidateProductId: string | null;
  candidateLabel: string | null;
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
