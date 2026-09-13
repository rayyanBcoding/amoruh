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
  /** A brand-new Master Product was auto-created for this row — never a
   *  match to something pre-existing (see pricing-process.ts's
   *  auto-creation eligibility check). Distinguished from "structured"
   *  (a genuine structural match) so the audit trail can always tell
   *  "matched to something known" apart from "AMORUH created this
   *  identity right now." */
  | "auto_created"
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
  /** Same idea as candidateProductId, for when the best guess is a
   *  Master/Reference Product AMORUH has never stocked rather than a
   *  real Product — mutually exclusive with candidateProductId (a
   *  suggestion is one or the other, never both). */
  candidateReferenceProductId: string | null;
  /** Set only when reviewStatus is needs_review because multiple
   *  plausible identities genuinely compete and the row itself doesn't
   *  specify enough to choose between them (e.g. "DIOR SAUVAGE 100ML"
   *  against EDT/EDP/Parfum Master Products — see pricing-matching.ts's
   *  row-relative ambiguity rule). Every competing identity, for
   *  display; each entry is either a real Product or a Master/Reference
   *  Product. candidateProductId/candidateReferenceProductId above stay
   *  the "top pick" for one-click actions in the ordinary needs_review
   *  case — this is only for the genuine-sibling-competition case. */
  competingCandidates?: { productId: string | null; referenceProductId: string | null }[];
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
  /** Real-catalog candidates an operator has explicitly rejected via
   *  "No — Not a Match" for THIS exact supplier item — see the identical
   *  field on SupplierOfferCurrent for why this exists and how it's
   *  carried forward. Recorded here too so the permanent history shows
   *  exactly what was rejected and when. Optional/defaults to empty —
   *  additive, most snapshots never have one. */
  rejectedCandidateProductIds?: string[];
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
  /** See the identical field on SupplierOfferSnapshot. */
  candidateReferenceProductId: string | null;
  /** See the identical field on SupplierOfferSnapshot. Not carried
   *  forward on its own — recomputed fresh every upload from whatever
   *  is currently ambiguous; only referenceProductId/rejectedCandidate-
   *  ProductIds below persist across uploads. */
  competingCandidates?: { productId: string | null; referenceProductId: string | null }[];
  matchType: OfferMatchType;
  matchConfidence: number | null;
  reviewStatus: ReviewStatus;
  /** See the identical field on SupplierOfferSnapshot — carried forward
   *  copy-forward-style across every re-upload of this offerKey, same as
   *  productId, so re-uploading a supplier's sheet never silently wipes
   *  out a tracked link an operator set. */
  referenceProductId: string | null;
  /** Real-catalog candidates an operator has explicitly rejected via
   *  "No — Not a Match" for THIS exact supplier item ("this suggested
   *  product is wrong," distinct from Ignore's "I don't want to review
   *  this item at all"). Carried forward copy-forward-style exactly like
   *  referenceProductId — never reset by a re-upload — so a rejected
   *  candidate is never re-suggested for this offerKey. Blocks ONLY the
   *  exact rejected productId(s); a different candidate (for the same or
   *  a different offerKey) is unaffected. Optional/defaults to empty. */
  rejectedCandidateProductIds?: string[];
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
  candidateReferenceProductId: string | null;
  /** See the identical field on SupplierOfferCurrent — set only for a
   *  genuine sibling-competition needs_review row. */
  competingCandidates?: { productId: string | null; referenceProductId: string | null }[];
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
  /** Sub-split of matched by whether the resolved identity is physically
   *  carried (productId set, on the real or linked Master Product) vs.
   *  a Master identity AMORUH has never stocked. matchedCarried +
   *  matchedReferenceOnly === matched always. */
  matchedCarried: number;
  matchedReferenceOnly: number;
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
  matchedCarried: number;
  matchedReferenceOnly: number;
  reviewRequired: number;
  newCandidates: number;
  newCandidatesUntracked: number;
  newCandidatesTracked: number;
  ignored: number;
  bySupplier: MatchReviewSupplierBreakdown[];
}

/** AMORUH's canonical Master Product identity — ONE record per exact
 *  sellable fragrance SKU, whether or not AMORUH has ever physically
 *  carried it. Supplier offers attach here; a real Product is created
 *  ONLY by Inventory Intake receiving or an intentional manual "Add
 *  Product" for stock actually owned — never by Pricing/Ordering,
 *  before or after Phase 2. Carries the full structured identity the
 *  matching engine extracts (see extractAttributes/classifyProductForm
 *  in pricing-matching.ts) so two candidates can only ever be treated
 *  as the same SKU when every material dimension agrees — never text
 *  similarity alone. Zero inventory on a Master Product means "never
 *  carried," never "sold out" — that distinction is what productId
 *  encodes below. */
export interface PricingReferenceProduct {
  id: string;
  brand: string;
  name: string;
  description: string;
  sizeMl: number | null;
  concentration: string | null;
  isTester: boolean;
  isGiftSet: boolean;
  /** Refill vs. standalone bottle — a materially different sellable SKU
   *  from either a bottle or a gift set, even at the same brand/size/
   *  concentration. */
  isRefill: boolean;
  /** "fragrance" (the default, covering the overwhelming majority of
   *  rows) or an explicit non-fragrance form (body lotion, deodorant,
   *  aftershave, body spray, shower gel, soap, candle, ...) — see
   *  classifyProductForm. A recognized, differing productForm on both
   *  sides is a hard gate everywhere this identity is compared against
   *  anything else; this is what stops a body lotion from ever being
   *  treated as the same SKU as an EDT. */
  productForm: string;
  upc: string;
  ean: string;
  /** Set ONLY by Inventory Intake's receiving-time integration hook, the
   *  moment this exact identity is actually stocked — never by anything
   *  in Pricing/Ordering, never a guess. null means "AMORUH has never
   *  carried this," not "sold out." */
  productId: string | null;
  createdAt: string;
  createdBy: string;
  /** Audit-only provenance for how/why this Master Product came to
   *  exist — never implies inventory ownership, never read by any
   *  matching/eligibility logic. Set exactly once, at genuine creation;
   *  a later get-or-create that resolves to this same existing record
   *  (a retry, a different supplier's matching offer, ...) never
   *  overwrites these. */
  creationMethod: "auto_import" | "manual_track";
  createdFromSupplierId: string | null;
  createdFromUploadId: string | null;
  createdFromOfferKey: string | null;
}

/** One master product's current price comparison across every supplier
 *  that currently (or previously) listed it. */
export interface ProductOfferComparison {
  productId: string;
  actionable: OfferComparisonRow[];
  nonActionable: OfferComparisonRow[];
  bestPrice: OfferComparisonRow | null;
}

/** Direct twin of ProductOfferComparison for a Master Product that has no
 *  linked real Product (or whose comparison view is entered via its
 *  Master identity) — same shape, keyed by referenceProductId instead. */
export interface ReferenceProductOfferComparison {
  referenceProductId: string;
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
