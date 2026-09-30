import { getProducts } from "./db";
import {
  bumpCatalogVersion,
  commitGeneration,
  createProcessSession,
  createUpload,
  getAliasesForSupplier,
  getAllReferenceProducts,
  getCommittedOffers,
  getOrCreateReferenceProductByIdentity,
  getProcessSession,
  getUpload,
  indexReferenceProductForSearch,
  markUploadFailed,
  newId,
  saveProcessSession,
  updateUploadProgress,
  writeCandidateGeneration,
  writeSnapshotsBatch,
  type OffersByProductOp,
  type OffersByReferenceProductOp,
  type ProcessSessionState,
} from "./pricing-db";
import {
  addToBrandBucketedPool,
  buildBrandBucketedPool,
  buildMasterCandidatePool,
  buildPreviousOfferIdentityIndex,
  checkAutoCreateEligibility,
  computeIdentitySignature,
  deriveOfferKey,
  extractAttributes,
  extractReferenceProductAttributes,
  isPlausibleBarcode,
  isValidProductRow,
  matchSupplierRow,
  resolveEffectiveBrand,
  findPreviousBySupplierItemIdentity,
  type BrandBucketedPool,
  type MatchPreviewSummary,
  type PreviousOfferIdentityIndex,
} from "./pricing-matching";
import {
  applyColumnMapping,
  columnMapInBounds,
  computeSanityChecks,
  parseSpreadsheetRaw,
  sheetColumnCount,
  verifyHeaderSignature,
} from "./pricing-parse";
import { getUsdRate, convertToUsd } from "./pricing-fx";
import type { SupplierColumnMapping } from "./intake-types";
import type {
  PricingReferenceProduct,
  SupplierAlias,
  SupplierOfferCurrent,
  SupplierOfferSnapshot,
  SupplierPriceUpload,
  SupplierRawRow,
} from "./pricing-types";

// ---------------------------------------------------------------------
// Orchestrates one upload end to end: STAGE everything (matching,
// immutable snapshots, the full candidate generation), then COMMIT with
// one small atomic script. See pricing-db.ts's header comment for why
// this split makes publication all-or-nothing and ordering-safe.
//
// A mid-file failure never corrupts the supplier's live pricing: nothing
// written during staging (snapshots, the candidate generation hash) is
// referenced by any reader until commitGeneration succeeds. If this
// throws at any point before that, the caller marks the upload "failed"
// and the previously-committed generation is completely untouched.
//
// Two entry points share every real function below:
//   - processSupplierUpload: the original single-shot version. Runs the
//     whole file in one call — fine for a small upload, and kept as the
//     ground-truth reference this module's own equivalence test compares
//     the batched version against.
//   - processSupplierUploadBatch: the resumable version /api/pricing/process
//     actually uses now. Splits the SAME per-row loop across bounded,
//     cursor-based calls (PROCESS_BATCH_SIZE rows each — measured safe
//     against the real Classic Wholesale file: ~5s/500 rows, see
//     scripts/measure-process-loop-real-file.ts), staging the loop's
//     accumulated state in a short-lived Redis session between calls.
//     The expensive persist/index/commit tail only ever runs ONCE, on
//     the batch that reaches the end of the file — a partial generation
//     can never publish, exactly like the single-shot path already
//     guaranteed for a mid-request crash, just spread over more requests
//     instead of one.
// ---------------------------------------------------------------------

const PROGRESS_UPDATE_INTERVAL = 200;
const PROCESS_BATCH_SIZE = 500;

// A real refprod_* id never starts with this — safe to distinguish a
// not-yet-persisted placeholder from a real identity by prefix alone.
const PENDING_PLACEHOLDER_PREFIX = "pending_";

export class ProcessSessionExpiredError extends Error {
  constructor() {
    super("This processing session has expired or is out of sync — restart from the beginning.");
    this.name = "ProcessSessionExpiredError";
  }
}

// ---------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------

async function parseAndValidateUploadFile(input: {
  blobUrl: string;
  headerRowIndex: number;
  headerSignature: string[];
  columnMap: SupplierColumnMapping["columnMap"];
}): Promise<{ rows: SupplierRawRow[] }> {
  const blobRes = await fetch(input.blobUrl);
  if (!blobRes.ok) throw new Error("Could not download the uploaded file.");
  const rawRows = parseSpreadsheetRaw(await blobRes.arrayBuffer());
  if (rawRows.length === 0) throw new Error("This file appears to be empty.");

  // Verify — never re-detect. If the confirmed header row no longer
  // holds the confirmed header text (the file changed, or a stale/
  // mismatched request), refuse rather than guessing a new mapping the
  // operator never saw in Preview. Re-checked on EVERY batch call, not
  // just the first — the same safety posture match-batch already uses.
  if (!verifyHeaderSignature(rawRows, input.headerRowIndex, input.headerSignature)) {
    throw new Error(
      "Confirmed mapping no longer matches this file's header row — return to Preview and review the spreadsheet mapping."
    );
  }
  const columnCount = sheetColumnCount(rawRows);
  if (!columnMapInBounds(input.columnMap, columnCount)) {
    throw new Error("Confirmed mapping no longer passes validation — return to Preview and review the spreadsheet mapping.");
  }

  const dataRows = rawRows.slice(input.headerRowIndex + 1);
  const rows = applyColumnMapping(dataRows, input.columnMap, input.headerSignature);

  // Re-run the SAME sanity checks Preview showed, server-side, before
  // anything is written — never trust that the disabled Process button
  // alone kept a bad mapping from reaching this point (stale browser
  // state, a UI bug, a changed file, or a misfired retry could all
  // otherwise bypass it).
  const sanity = computeSanityChecks(rows);
  if (!sanity.ok) {
    throw new Error(`Confirmed mapping no longer passes validation — return to Preview and review the spreadsheet mapping. (${sanity.warnings.join(" ")})`);
  }
  return { rows };
}

export interface RowProcessingContext {
  supplierId: string;
  uploadId: string;
  nowIso: string;
  products: Awaited<ReturnType<typeof getProducts>>;
  /** The supplier's aliases as of the START of this upload — fixed;
   *  never includes this run's own newAliases (those are checked via
   *  aliasesSoFar inside processRow, same as the original). */
  existingAliases: SupplierAlias[];
  /** Mutable — a row that auto-creates pushes its placeholder in
   *  immediately, so a LATER row (in this batch or a later one, via the
   *  caller re-applying prior placeholders each call) sees it through
   *  the normal exact-match path. */
  referenceProducts: PricingReferenceProduct[];
  /** Mutable in lockstep with referenceProducts above. */
  candidatePool: BrandBucketedPool;
  previousOfferIdentityIndex: PreviousOfferIdentityIndex;
}

export interface RowProcessingState {
  candidateOffers: Record<string, SupplierOfferCurrent>;
  touchedKeys: Set<string>;
  newAliases: SupplierAlias[];
  offersByProductOps: OffersByProductOp[];
  offersByReferenceProductOps: OffersByReferenceProductOp[];
  snapshots: SupplierOfferSnapshot[];
  autoMatched: number;
  autoCreated: number;
  needsReview: number;
  notAProduct: number;
  pendingPersistSeq: number;
  pendingPersists: {
    placeholderId: string;
    identity: { upc: string; ean: string; signature: string };
    newRecordInput: Omit<PricingReferenceProduct, "id" | "createdAt">;
  }[];
  /** Every row whose finalReferenceProductId ended up being a
   *  placeholder — the ORIGINAL auto-create row (via pendingPersists)
   *  AND any later row that matched against it normally. */
  placeholderUsage: Map<string, { rowIndex: number; offerKey: string }[]>;
}

export function createEmptyRowProcessingState(): RowProcessingState {
  return {
    candidateOffers: {},
    touchedKeys: new Set(),
    newAliases: [],
    offersByProductOps: [],
    offersByReferenceProductOps: [],
    snapshots: [],
    autoMatched: 0,
    autoCreated: 0,
    needsReview: 0,
    notAProduct: 0,
    pendingPersistSeq: 0,
    pendingPersists: [],
    placeholderUsage: new Map(),
  };
}

/** Processes exactly ONE row, mutating `state` and (for a genuinely new
 *  identity) `ctx.referenceProducts`/`ctx.candidatePool` in place. This
 *  is the single source of truth for per-row matching/auto-create
 *  eligibility/carry-forward decisions — both processSupplierUpload and
 *  processSupplierUploadBatch call this and nothing else for that
 *  logic, so chunking can never itself change a decision. Never awaits
 *  anything durable — getUsdRate's only real cost is a non-USD currency
 *  rate lookup, and even that never mutates state that must survive a
 *  chunk boundary in a way this function doesn't already return via its
 *  mutations. */
export async function processRow(row: SupplierRawRow, i: number, ctx: RowProcessingContext, state: RowProcessingState): Promise<void> {
  // Non-product rows (headers/notes/totals/shipping/blank/category
  // lines) are classified BEFORE any matching runs — they never enter
  // Match Review, are never auto-created, and only ever show up as the
  // nonProductRows import-summary count. Still recorded as a snapshot
  // for audit ("here's exactly why row 47 was skipped"), same as every
  // other row.
  if (!isValidProductRow(row)) {
    const offerKey = deriveOfferKey(row.supplierSku, row.description);
    state.notAProduct++;
    state.snapshots.push({
      id: newId("offersnap"),
      uploadId: ctx.uploadId,
      rowIndex: i,
      supplierId: ctx.supplierId,
      offerKey,
      raw: row,
      productId: null,
      candidateProductId: null,
      candidateReferenceProductId: null,
      matchType: "unmatched",
      matchConfidence: null,
      reviewStatus: "not_a_product",
      referenceProductId: null,
      rejectedCandidateProductIds: [],
      currency: row.currency,
      price: row.price,
      fxRateAtUpload: null,
      fxRateTimestamp: null,
      priceUsdAtUpload: null,
      uploadedAt: ctx.nowIso,
    });
    state.touchedKeys.add(offerKey);
    state.candidateOffers[offerKey] = {
      supplierId: ctx.supplierId,
      offerKey,
      supplierSku: row.supplierSku,
      description: row.description,
      brand: row.brand,
      quantity: row.quantity,
      currency: row.currency,
      price: row.price,
      fxRateAtUpload: null,
      fxRateTimestamp: null,
      priceUsdAtUpload: null,
      upc: row.upc,
      ean: row.ean,
      productId: null,
      candidateProductId: null,
      candidateReferenceProductId: null,
      matchType: "unmatched",
      matchConfidence: null,
      reviewStatus: "not_a_product",
      referenceProductId: null,
      rejectedCandidateProductIds: [],
      reviewRequestedAt: null,
      currentlyListed: true,
      lastUploadId: ctx.uploadId,
      uploadedAt: ctx.nowIso,
    };
    return;
  }

  const offerKey = deriveOfferKey(row.supplierSku, row.description);
  const aliasesSoFar = ctx.existingAliases.concat(state.newAliases);
  const match = matchSupplierRow(
    { offerKey, supplierSku: row.supplierSku, description: row.description, brand: row.brand, upc: row.upc, ean: row.ean },
    ctx.products,
    aliasesSoFar,
    ctx.referenceProducts,
    ctx.candidatePool
  );

  const rate = await getUsdRate(row.currency);
  const priceUsd = convertToUsd(row.price, rate?.rate ?? null);

  // Direct offerKey lookup first — the normal, fast path, confirmed
  // stable across real repeat uploads (see the Match Review audit).
  // Only when that misses does the conservative identity fallback try
  // to reconnect this row to its OWN prior supplier-item history under a
  // different offerKey (e.g. the supplier reformatted their SKU
  // column) — see findPreviousBySupplierItemIdentity's own comments for
  // exactly what it will and won't reconnect.
  let previous = state.candidateOffers[offerKey];
  let reconnectedViaFallback = false;
  if (!previous) {
    const fallback = findPreviousBySupplierItemIdentity(
      { upc: row.upc, ean: row.ean, brand: row.brand, description: row.description },
      ctx.previousOfferIdentityIndex
    );
    if (fallback) {
      previous = fallback;
      reconnectedViaFallback = true;
    }
  }

  // Carry-forward decision, applied on top of matchSupplierRow's own
  // fresh result — never the other way around, so a genuinely stronger
  // new signal (e.g. a UPC now cleanly resolves) always wins over stale
  // carried-forward state:
  //   - an intentionally "ignored" decision survives a re-upload unless
  //     today's fresh match is a clean auto_matched (real new evidence
  //     appeared);
  //   - otherwise, if today's fresh match found nothing (new_candidate)
  //     AND the identity fallback reconnected this row to a
  //     previously-resolved item, adopt that prior resolution rather
  //     than treating a reformatted-SKU row as brand new.
  let finalReviewStatus = match.reviewStatus;
  let finalProductId = match.productId;
  let finalCandidateProductId = match.candidateProductId;
  let finalCandidateReferenceProductId = match.candidateReferenceProductId;
  let finalCompetingCandidates = match.competingCandidates;
  let finalMatchType = match.matchType;
  let finalMatchConfidence = match.matchConfidence;
  if (previous?.reviewStatus === "ignored" && match.reviewStatus !== "auto_matched") {
    finalReviewStatus = "ignored";
    finalProductId = null;
    finalCandidateProductId = null;
    finalCandidateReferenceProductId = null;
    finalCompetingCandidates = undefined;
    finalMatchType = "unmatched";
    finalMatchConfidence = null;
  } else if (reconnectedViaFallback && match.reviewStatus === "new_candidate" && previous) {
    finalReviewStatus = previous.reviewStatus;
    finalProductId = previous.productId;
    finalCandidateProductId = previous.candidateProductId;
    finalCandidateReferenceProductId = previous.candidateReferenceProductId;
    // Not carried from `previous` — competingCandidates is always
    // recomputed fresh, never persisted state; a fallback-reconnected
    // row simply has none.
    finalCompetingCandidates = undefined;
    finalMatchType = previous.matchType;
    finalMatchConfidence = previous.matchConfidence;
  }

  // "No — Not a Match" carry-forward: an operator explicitly rejected
  // THIS exact candidate for THIS exact supplier item before — never
  // re-suggest it. Applied last, on top of whichever branch above
  // produced the current candidate, so it catches a rejected product
  // resurfacing via either the normal match or the identity fallback.
  const rejectedIds = previous?.rejectedCandidateProductIds ?? [];
  if (finalCandidateProductId && rejectedIds.includes(finalCandidateProductId)) {
    finalCandidateProductId = null;
    finalMatchConfidence = null;
  }

  // Corrected operating model: "no existing match" is never itself an
  // end state. Every row that reaches here (matchSupplierRow found
  // nothing) resolves immediately into exactly one of three real
  // outcomes — no purgatory in between:
  //  1. Already tracked (finalReferenceProductId set from a prior
  //     "Track for Pricing" on an earlier generation) — matched, full
  //     stop.
  //  2. Structurally complete (checkAutoCreateEligibility passes) —
  //     auto-create the Master Product and attach the offer. Expected,
  //     routine catalog growth, never an error or a queue.
  //  3. Genuinely incomplete/ambiguous — Match Review, because the
  //     exact SKU truly cannot be determined yet. Auto-creating here
  //     would lock in a guess.
  let finalReferenceProductId = match.referenceProductId ?? (previous?.referenceProductId ?? null);
  if (finalReviewStatus === "new_candidate") {
    if (finalReferenceProductId) {
      finalReviewStatus = "auto_matched";
      finalMatchType = "manual";
      finalMatchConfidence = 1;
      finalCandidateProductId = null;
      finalCandidateReferenceProductId = null;
      finalCompetingCandidates = undefined;
    } else {
      // A supplier's own placeholder text ("NO BARCODE" etc.) must never
      // become a stored identity pointer — treat it as absent here, same
      // as everywhere else upc/ean is used as an identifier.
      const plausibleUpc = isPlausibleBarcode(row.upc.trim().toUpperCase()) ? row.upc.trim() : "";
      const plausibleEan = isPlausibleBarcode(row.ean.trim().toUpperCase()) ? row.ean.trim() : "";
      const effectiveBrand = resolveEffectiveBrand(row, ctx.products, ctx.referenceProducts);
      const rowAttrs = extractAttributes(`${row.brand} ${row.description}`, effectiveBrand);
      const eligibility = checkAutoCreateEligibility(rowAttrs, Boolean(plausibleUpc || plausibleEan));
      if (!eligibility.eligible) {
        finalReviewStatus = "needs_review";
        finalMatchType = "unmatched";
        finalMatchConfidence = null;
        finalCandidateProductId = null;
        finalCandidateReferenceProductId = null;
        finalCompetingCandidates = undefined;
      } else {
        const signature = computeIdentitySignature(rowAttrs);
        const placeholderId = `${PENDING_PLACEHOLDER_PREFIX}${state.pendingPersistSeq++}`;
        const newRecordInput: Omit<PricingReferenceProduct, "id" | "createdAt"> = {
          brand: effectiveBrand,
          name: row.description.trim(),
          description: row.description.trim(),
          sizeMl: rowAttrs.sizeMl,
          concentration: rowAttrs.concentration,
          isTester: rowAttrs.isTester,
          isGiftSet: rowAttrs.isGiftSet,
          isRefill: rowAttrs.isRefill,
          productForm: rowAttrs.productForm,
          upc: plausibleUpc,
          ean: plausibleEan,
          productId: null,
          createdBy: "auto_import",
          creationMethod: "auto_import",
          createdFromSupplierId: ctx.supplierId,
          createdFromUploadId: ctx.uploadId,
          createdFromOfferKey: offerKey,
        };
        state.pendingPersists.push({ placeholderId, identity: { upc: plausibleUpc, ean: plausibleEan, signature }, newRecordInput });

        finalReferenceProductId = placeholderId;
        finalReviewStatus = "auto_matched";
        finalMatchType = "auto_created";
        finalMatchConfidence = 1;
        finalCandidateProductId = null;
        finalCandidateReferenceProductId = null;
        finalCompetingCandidates = undefined;

        // Make this visible to every LATER row this same batch (and, via
        // the caller re-applying pendingPersists next batch, every later
        // batch too) — same purpose as the real record would serve.
        const placeholderRecord: PricingReferenceProduct = { id: placeholderId, ...newRecordInput, createdAt: ctx.nowIso };
        ctx.referenceProducts.push(placeholderRecord);
        addToBrandBucketedPool(ctx.candidatePool, {
          productId: null,
          referenceProductId: placeholderId,
          attrs: extractReferenceProductAttributes(placeholderRecord),
          upc: placeholderRecord.upc,
          ean: placeholderRecord.ean,
        });
      }
    }
  }

  // Whether a genuinely-ambiguous item is flagged for the ACTIVE review
  // queue is completely independent of the fresh match above.
  const finalReviewRequestedAt = finalReviewStatus === "needs_review" ? (previous?.reviewRequestedAt ?? null) : null;

  if (finalReferenceProductId && finalReferenceProductId.startsWith(PENDING_PLACEHOLDER_PREFIX)) {
    const usage = state.placeholderUsage.get(finalReferenceProductId);
    if (usage) usage.push({ rowIndex: i, offerKey });
    else state.placeholderUsage.set(finalReferenceProductId, [{ rowIndex: i, offerKey }]);
  }

  state.snapshots.push({
    id: newId("offersnap"),
    uploadId: ctx.uploadId,
    rowIndex: i,
    supplierId: ctx.supplierId,
    offerKey,
    raw: row,
    productId: finalProductId,
    candidateProductId: finalCandidateProductId,
    candidateReferenceProductId: finalCandidateReferenceProductId,
    competingCandidates: finalCompetingCandidates,
    matchType: finalMatchType,
    matchConfidence: finalMatchConfidence,
    reviewStatus: finalReviewStatus,
    referenceProductId: finalReferenceProductId,
    rejectedCandidateProductIds: rejectedIds,
    reviewRequestedAt: finalReviewRequestedAt,
    currency: row.currency,
    price: row.price,
    fxRateAtUpload: rate?.rate ?? null,
    fxRateTimestamp: rate?.timestamp ?? null,
    priceUsdAtUpload: priceUsd,
    uploadedAt: ctx.nowIso,
  });

  state.touchedKeys.add(offerKey);
  const nextOffer: SupplierOfferCurrent = {
    supplierId: ctx.supplierId,
    offerKey,
    supplierSku: row.supplierSku,
    description: row.description,
    brand: row.brand,
    quantity: row.quantity,
    currency: row.currency,
    price: row.price,
    fxRateAtUpload: rate?.rate ?? null,
    fxRateTimestamp: rate?.timestamp ?? null,
    priceUsdAtUpload: priceUsd,
    upc: row.upc,
    ean: row.ean,
    productId: finalProductId,
    candidateProductId: finalCandidateProductId,
    candidateReferenceProductId: finalCandidateReferenceProductId,
    competingCandidates: finalCompetingCandidates,
    matchType: finalMatchType,
    matchConfidence: finalMatchConfidence,
    reviewStatus: finalReviewStatus,
    referenceProductId: finalReferenceProductId,
    rejectedCandidateProductIds: rejectedIds,
    reviewRequestedAt: finalReviewRequestedAt,
    currentlyListed: true,
    lastUploadId: ctx.uploadId,
    uploadedAt: ctx.nowIso,
  };
  state.candidateOffers[offerKey] = nextOffer;

  const member = `${ctx.supplierId}::${offerKey}`;
  const priorSameKeyProductId = reconnectedViaFallback ? null : (previous?.productId ?? null);
  if (priorSameKeyProductId && priorSameKeyProductId !== finalProductId) {
    state.offersByProductOps.push({ op: "SREM", productId: priorSameKeyProductId, member });
  }
  if (finalProductId && priorSameKeyProductId !== finalProductId) {
    state.offersByProductOps.push({ op: "SADD", productId: finalProductId, member });
  }

  const priorSameKeyReferenceProductId = reconnectedViaFallback ? null : (previous?.referenceProductId ?? null);
  if (priorSameKeyReferenceProductId && priorSameKeyReferenceProductId !== finalReferenceProductId) {
    state.offersByReferenceProductOps.push({ op: "SREM", referenceProductId: priorSameKeyReferenceProductId, member });
  }
  if (finalReferenceProductId && priorSameKeyReferenceProductId !== finalReferenceProductId) {
    state.offersByReferenceProductOps.push({ op: "SADD", referenceProductId: finalReferenceProductId, member });
  }

  // A newly-confirmed high-confidence match (not already a learned
  // alias) becomes one — so this exact supplier SKU/description never
  // asks again.
  if (
    finalReviewStatus === "auto_matched" &&
    finalMatchType !== "alias" &&
    finalProductId &&
    !aliasesSoFar.some((a) => a.offerKey === offerKey && a.productId === finalProductId)
  ) {
    state.newAliases.push({
      id: newId("alias"),
      supplierId: ctx.supplierId,
      offerKey,
      productId: finalProductId,
      createdAt: ctx.nowIso,
      source: "auto_high_confidence",
    });
  }

  if (
    reconnectedViaFallback &&
    finalProductId &&
    !aliasesSoFar.some((a) => a.offerKey === offerKey && a.productId === finalProductId)
  ) {
    state.newAliases.push({
      id: newId("alias"),
      supplierId: ctx.supplierId,
      offerKey,
      productId: finalProductId,
      createdAt: ctx.nowIso,
      source: "auto_high_confidence",
    });
  }

  if (finalReviewStatus === "auto_matched") {
    if (finalMatchType === "auto_created") state.autoCreated++;
    else state.autoMatched++;
  } else if (finalReviewStatus !== "ignored") {
    state.needsReview++; // needs_review, alias_conflict, barcode_conflict
  }
}

/** The persist/index/commit tail — identical in both entry points.
 *  Reads `state`'s accumulated data (already complete by the time this
 *  runs; the caller guarantees every row has been processed) and
 *  performs the SAME atomic publish the single-shot path always did. */
async function finalizeUpload(params: {
  upload: SupplierPriceUpload;
  uploadType: "full" | "partial";
  existingAliases: SupplierAlias[];
  generationId: string;
  totalRows: number;
  state: RowProcessingState;
}): Promise<SupplierPriceUpload> {
  const { upload, uploadType, existingAliases, generationId, totalRows, state } = params;

  // Deferred parallel persist — resolves every placeholder queued above
  // via the SAME atomic get-or-create script, concurrently. Chunked, not
  // one unbounded Promise.all.
  const PERSIST_CONCURRENCY = 100;
  const persistResults = new Map<
    string,
    { status: "created"; id: string; product: PricingReferenceProduct } | { status: "existing"; id: string } | { status: "conflict"; ids: string[] }
  >();
  const newlyCreatedForIndexing: PricingReferenceProduct[] = [];
  for (let i = 0; i < state.pendingPersists.length; i += PERSIST_CONCURRENCY) {
    const chunk = state.pendingPersists.slice(i, i + PERSIST_CONCURRENCY);
    const results = await Promise.all(chunk.map((p) => getOrCreateReferenceProductByIdentity(p.identity, p.newRecordInput, { skipSearchIndexAndVersionBump: true })));
    chunk.forEach((p, idx) => {
      const r = results[idx];
      if (r.status === "conflict") {
        persistResults.set(p.placeholderId, { status: "conflict", ids: r.ids });
      } else if (r.status === "created") {
        persistResults.set(p.placeholderId, { status: "created", id: r.id, product: r.product });
        newlyCreatedForIndexing.push(r.product);
      } else {
        persistResults.set(p.placeholderId, { status: "existing", id: r.id });
      }
    });
  }
  // One dedicated bulk pass: every product actually created above
  // becomes searchable, and catalogVersion is bumped exactly once for
  // the whole upload — still fires even if this generation's own commit
  // later turns out stale.
  if (newlyCreatedForIndexing.length > 0) {
    const INDEX_CONCURRENCY = 100;
    for (let i = 0; i < newlyCreatedForIndexing.length; i += INDEX_CONCURRENCY) {
      await Promise.all(newlyCreatedForIndexing.slice(i, i + INDEX_CONCURRENCY).map((p) => indexReferenceProductForSearch(p)));
    }
    await bumpCatalogVersion();
  }

  // Patch EVERY row that ended up referencing a placeholder — not just
  // the row that originally queued it — with its now-resolved real
  // identity, or, for a genuine identity conflict, revert to
  // needs_review.
  for (const [placeholderId, usedBy] of state.placeholderUsage) {
    const result = persistResults.get(placeholderId);
    if (!result) continue; // unreachable — every placeholder is queued in pendingPersists and gets a result above

    if (result.status === "conflict") {
      const conflictCandidates = result.ids.map((id) => ({ productId: null, referenceProductId: id }));
      for (const { rowIndex, offerKey } of usedBy) {
        const snapshot = state.snapshots[rowIndex];
        const offer = state.candidateOffers[offerKey];
        if (snapshot && snapshot.referenceProductId === placeholderId) {
          if (snapshot.matchType === "auto_created") state.autoCreated--;
          else state.autoMatched--;
          state.needsReview++;
          snapshot.referenceProductId = null;
          snapshot.reviewStatus = "needs_review";
          snapshot.matchType = "unmatched";
          snapshot.matchConfidence = null;
          snapshot.competingCandidates = conflictCandidates;
        }
        if (offer && offer.referenceProductId === placeholderId) {
          offer.referenceProductId = null;
          offer.reviewStatus = "needs_review";
          offer.matchType = "unmatched";
          offer.matchConfidence = null;
          offer.competingCandidates = conflictCandidates;
        }
      }
      for (let idx = state.offersByReferenceProductOps.length - 1; idx >= 0; idx--) {
        if (state.offersByReferenceProductOps[idx].referenceProductId === placeholderId) state.offersByReferenceProductOps.splice(idx, 1);
      }
    } else {
      for (const { rowIndex, offerKey } of usedBy) {
        const snapshot = state.snapshots[rowIndex];
        const offer = state.candidateOffers[offerKey];
        if (snapshot && snapshot.referenceProductId === placeholderId) snapshot.referenceProductId = result.id;
        if (offer && offer.referenceProductId === placeholderId) offer.referenceProductId = result.id;
      }
      for (const op of state.offersByReferenceProductOps) {
        if (op.referenceProductId === placeholderId) op.referenceProductId = result.id;
      }
    }
  }

  // Full upload: anything from the previous generation this file never
  // mentioned is no longer listed — kept, never deleted, still
  // discoverable and still carrying its full history.
  if (uploadType === "full") {
    for (const [offerKey, offer] of Object.entries(state.candidateOffers)) {
      if (!state.touchedKeys.has(offerKey) && offer.currentlyListed) {
        state.candidateOffers[offerKey] = { ...offer, currentlyListed: false };
      }
    }
  }

  await writeCandidateGeneration(upload.supplierId, generationId, state.candidateOffers);
  await writeSnapshotsBatch(state.snapshots);

  const finishedUpload: SupplierPriceUpload = {
    ...upload,
    status: "completed",
    processedRows: totalRows,
    autoMatched: state.autoMatched,
    autoCreated: state.autoCreated,
    needsReview: state.needsReview,
    newCandidates: 0, // legacy — always 0 under the corrected model
    notAProduct: state.notAProduct,
    completedAt: new Date().toISOString(),
  };

  const commitResult = await commitGeneration({
    supplierId: upload.supplierId,
    uploadId: upload.id,
    seq: upload.seq,
    generationId,
    finishedUpload,
    newAliases: existingAliases.concat(state.newAliases),
    offersByProductOps: state.offersByProductOps,
    offersByReferenceProductOps: state.offersByReferenceProductOps,
  });

  // STALE_GENERATION: this upload fully and correctly processed every
  // row, but a newer upload (higher seq) already committed first — the
  // script returns before writing anything (including the upload record
  // itself), so persist the completed state here instead. Retained in
  // history but deliberately never made current.
  if (commitResult === "STALE_GENERATION") {
    await updateUploadProgress(upload.id, finishedUpload);
  }
  return finishedUpload;
}

// ---------------------------------------------------------------------
// Entry point 1 — single-shot (kept as the ground-truth reference; see
// scripts/test-process-batch-equivalence.ts).
// ---------------------------------------------------------------------

export async function processSupplierUpload(input: {
  supplierId: string;
  filename: string;
  blobUrl: string;
  uploadType: "full" | "partial";
  headerRowIndex: number;
  headerSignature: string[];
  columnMap: SupplierColumnMapping["columnMap"];
  retryUploadId?: string;
}): Promise<SupplierPriceUpload> {
  let upload: SupplierPriceUpload;
  if (input.retryUploadId) {
    const existing = await getUpload(input.retryUploadId);
    if (!existing || existing.supplierId !== input.supplierId) {
      throw new Error("Upload to retry was not found for this supplier.");
    }
    if (existing.status !== "failed") {
      throw new Error(`Only a failed upload can be retried (this one is "${existing.status}").`);
    }
    upload = { ...existing, status: "processing", processedRows: 0, error: null, completedAt: null };
    await updateUploadProgress(upload.id, upload);
  } else {
    upload = await createUpload({
      supplierId: input.supplierId,
      filename: input.filename,
      blobUrl: input.blobUrl,
      uploadType: input.uploadType,
      totalRows: 0,
    });
  }

  try {
    const { rows } = await parseAndValidateUploadFile(input);
    await updateUploadProgress(upload.id, { totalRows: rows.length });

    const [products, existingAliases, previousOffers, referenceProducts] = await Promise.all([
      getProducts(),
      getAliasesForSupplier(input.supplierId),
      getCommittedOffers(input.supplierId),
      getAllReferenceProducts(),
    ]);

    const candidatePool: BrandBucketedPool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));
    const previousOfferIdentityIndex = buildPreviousOfferIdentityIndex(previousOffers);

    const ctx: RowProcessingContext = {
      supplierId: input.supplierId,
      uploadId: upload.id,
      nowIso: new Date().toISOString(),
      products,
      existingAliases,
      referenceProducts,
      candidatePool,
      previousOfferIdentityIndex,
    };
    const state = createEmptyRowProcessingState();
    state.candidateOffers = { ...previousOffers };

    for (let i = 0; i < rows.length; i++) {
      await processRow(rows[i], i, ctx, state);
      if ((i + 1) % PROGRESS_UPDATE_INTERVAL === 0) {
        await updateUploadProgress(upload.id, { processedRows: i + 1 });
      }
    }

    const generationId = newId("gen");
    return await finalizeUpload({ upload, uploadType: input.uploadType, existingAliases, generationId, totalRows: rows.length, state });
  } catch (err) {
    await markUploadFailed(upload.id, err instanceof Error ? err.message : "Processing failed.");
    throw err;
  }
}

// ---------------------------------------------------------------------
// Entry point 2 — resumable (what /api/pricing/process actually calls
// now). See this file's header comment for the design.
// ---------------------------------------------------------------------

export interface ProcessBatchResult {
  sessionId: string | null;
  cursor: number;
  totalRows: number;
  done: boolean;
  upload: SupplierPriceUpload;
}

export async function processSupplierUploadBatch(input: {
  supplierId: string;
  filename: string;
  blobUrl: string;
  uploadType: "full" | "partial";
  headerRowIndex: number;
  headerSignature: string[];
  columnMap: SupplierColumnMapping["columnMap"];
  retryUploadId?: string;
  cursor: number;
  sessionId?: string;
}): Promise<ProcessBatchResult> {
  let upload: SupplierPriceUpload;
  let session: ProcessSessionState | null = null;

  if (input.sessionId) {
    const existing = await getProcessSession(input.sessionId);
    // Idempotent replay of the FINAL batch request: if the session is
    // still there (never deleted — see the success path below, which
    // deliberately leaves it for the TTL to clean up rather than
    // deleting it immediately) and its own upload already completed,
    // this is a retry of a request whose response was lost in transit
    // after the server had already committed — return the SAME final
    // result again rather than re-running finalizeUpload (which would
    // re-do real work) or falling through to ProcessSessionExpiredError
    // (which would make the client restart the WHOLE upload from row 0,
    // creating a second, confusing generation/upload for what the
    // operator sees as one Process click — commitGeneration's own seq
    // guard would still stop that second attempt from ever becoming the
    // LIVE generation, but it's real wasted work and a real second
    // history record, worth avoiding, not just tolerating).
    if (existing) {
      const existingUpload = await getUpload(existing.uploadId);
      if (existingUpload?.status === "completed") {
        return { sessionId: null, cursor: existingUpload.totalRows, totalRows: existingUpload.totalRows, done: true, upload: existingUpload };
      }
    }
    if (!existing || existing.cursor !== input.cursor) throw new ProcessSessionExpiredError();
    session = existing;
    const existingUpload = await getUpload(session.uploadId);
    if (!existingUpload) throw new Error("Upload record went missing mid-process.");
    upload = existingUpload;
  } else {
    if (input.cursor !== 0) throw new ProcessSessionExpiredError();
    if (input.retryUploadId) {
      const existing = await getUpload(input.retryUploadId);
      if (!existing || existing.supplierId !== input.supplierId) {
        throw new Error("Upload to retry was not found for this supplier.");
      }
      if (existing.status !== "failed") {
        throw new Error(`Only a failed upload can be retried (this one is "${existing.status}").`);
      }
      upload = { ...existing, status: "processing", processedRows: 0, error: null, completedAt: null };
      await updateUploadProgress(upload.id, upload);
    } else {
      upload = await createUpload({
        supplierId: input.supplierId,
        filename: input.filename,
        blobUrl: input.blobUrl,
        uploadType: input.uploadType,
        totalRows: 0,
      });
    }
  }

  try {
    const { rows } = await parseAndValidateUploadFile(input);
    const totalRows = rows.length;

    if (!session) {
      await updateUploadProgress(upload.id, { totalRows });
      const previousOffers = await getCommittedOffers(input.supplierId);
      session = {
        uploadId: upload.id,
        generationId: newId("gen"),
        seq: upload.seq,
        cursor: 0,
        previousOffers,
        candidateOffers: { ...previousOffers },
        snapshots: [],
        newAliases: [],
        offersByProductOps: [],
        offersByReferenceProductOps: [],
        pendingPersists: [],
        placeholderUsage: {},
        touchedKeys: [],
        autoMatched: 0,
        autoCreated: 0,
        needsReview: 0,
        notAProduct: 0,
        pendingPersistSeq: 0,
      };
    }

    // Rebuilt fresh EVERY batch — cheap (~2s), avoids ever serializing
    // the ~15,000-record catalog into session storage. Mirrors
    // parse-preview/match-batch's own proven pattern exactly.
    const [products, existingAliases, referenceProducts] = await Promise.all([
      getProducts(),
      getAliasesForSupplier(input.supplierId),
      getAllReferenceProducts(),
    ]);

    // Re-apply this session's own placeholder creations on top of the
    // fresh real catalog BEFORE building the pool, so a later batch's
    // row can still structurally match an earlier batch's auto-create —
    // identical in spirit to stepMatchPreviewBatch's previewPoolAdditions.
    const nowIso = new Date().toISOString();
    const mutableReferenceProducts = [...referenceProducts];
    for (const p of session.pendingPersists) {
      mutableReferenceProducts.push({ id: p.placeholderId, ...p.newRecordInput, createdAt: nowIso });
    }
    const candidatePool = buildBrandBucketedPool(buildMasterCandidatePool(products, mutableReferenceProducts));

    // previousOfferIdentityIndex reflects offer history as of the START
    // of this upload — rebuilt fresh each batch from the FIXED snapshot
    // taken at session creation, never from a fresh getCommittedOffers
    // call (which could drift between batches if something else committed
    // to this same supplier mid-run).
    const previousOfferIdentityIndex = buildPreviousOfferIdentityIndex(session.previousOffers);

    const ctx: RowProcessingContext = {
      supplierId: input.supplierId,
      uploadId: upload.id,
      nowIso,
      products,
      existingAliases,
      referenceProducts: mutableReferenceProducts,
      candidatePool,
      previousOfferIdentityIndex,
    };
    const state: RowProcessingState = {
      candidateOffers: session.candidateOffers,
      touchedKeys: new Set(session.touchedKeys),
      newAliases: session.newAliases,
      offersByProductOps: session.offersByProductOps,
      offersByReferenceProductOps: session.offersByReferenceProductOps,
      snapshots: session.snapshots,
      autoMatched: session.autoMatched,
      autoCreated: session.autoCreated,
      needsReview: session.needsReview,
      notAProduct: session.notAProduct,
      pendingPersistSeq: session.pendingPersistSeq,
      pendingPersists: session.pendingPersists,
      placeholderUsage: new Map(Object.entries(session.placeholderUsage)),
    };

    const batchEnd = Math.min(input.cursor + PROCESS_BATCH_SIZE, totalRows);
    for (let i = input.cursor; i < batchEnd; i++) {
      await processRow(rows[i], i, ctx, state);
    }
    const nextCursor = batchEnd;
    const done = nextCursor >= totalRows;

    if (!done) {
      await updateUploadProgress(upload.id, { processedRows: nextCursor });
      const nextSession: ProcessSessionState = {
        uploadId: session.uploadId,
        generationId: session.generationId,
        seq: session.seq,
        cursor: nextCursor,
        previousOffers: session.previousOffers,
        candidateOffers: state.candidateOffers,
        snapshots: state.snapshots,
        newAliases: state.newAliases,
        offersByProductOps: state.offersByProductOps,
        offersByReferenceProductOps: state.offersByReferenceProductOps,
        pendingPersists: state.pendingPersists,
        placeholderUsage: Object.fromEntries(state.placeholderUsage),
        touchedKeys: [...state.touchedKeys],
        autoMatched: state.autoMatched,
        autoCreated: state.autoCreated,
        needsReview: state.needsReview,
        notAProduct: state.notAProduct,
        pendingPersistSeq: state.pendingPersistSeq,
      };
      const sessionId = input.sessionId ?? newId("processsession");
      if (input.sessionId) await saveProcessSession(sessionId, nextSession);
      else await createProcessSession(sessionId, nextSession);
      const progressUpload = (await getUpload(upload.id)) ?? upload;
      return { sessionId, cursor: nextCursor, totalRows, done: false, upload: progressUpload };
    }

    const finished = await finalizeUpload({
      upload,
      uploadType: input.uploadType,
      existingAliases,
      generationId: session.generationId,
      totalRows,
      state,
    });
    // Deliberately NOT deleted here — see the idempotent-replay check at
    // the top of this function, which needs the session to still be
    // findable (with its upload now "completed") to recognize a retry of
    // THIS exact request rather than treating it as expired. It still
    // self-cleans via its own TTL either way, same as an abandoned
    // mid-upload session already did before this change.
    return { sessionId: null, cursor: nextCursor, totalRows, done: true, upload: finished };
  } catch (err) {
    await markUploadFailed(upload.id, err instanceof Error ? err.message : "Processing failed.");
    throw err;
  }
}

// ---------------------------------------------------------------------
// Import safety — the second line of defense the new auto-creation
// feature specifically needs, on top of the EXISTING header/mapping
// sanity checks (verifyHeaderSignature/computeSanityChecks, unchanged).
// Never a flat row-count-drop percentage, and — corrected — never keyed
// off the "new items" rate at all: with every new distributor, thousands
// of products may legitimately enter AMORUH for the first time, and
// that is expected, routine catalog growth, never suspicious by itself.
// What IS worth a caution is a jump in the genuinely-AMBIGUOUS rate
// (requiresReview) relative to THIS SAME SUPPLIER's own history — that's
// the signal a broken mapping (a shifted column, a garbled description)
// actually produces, not "lots of new SKUs."
// ---------------------------------------------------------------------

export interface ImportAnomalyAssessment {
  flagged: boolean;
  message: string | null;
  currentReviewRate: number;
  priorReviewRate: number | null;
}

/** Compares this preview's requiresReview rate against the prior rate
 *  from the same supplier's most recent COMPLETED upload (skips failed/
 *  in-progress ones — those never reflect a real matched baseline). No
 *  prior completed upload (a supplier's very first file) means there is
 *  no baseline to compare against, so this never blocks a first upload
 *  — nor does a high proposedNewMasterProducts rate ever flag anything,
 *  by design. */
export function assessImportAnomalyRisk(preview: MatchPreviewSummary, priorUploads: SupplierPriceUpload[]): ImportAnomalyAssessment {
  const currentReviewRate = preview.totalRows > 0 ? preview.requiresReview / preview.totalRows : 0;

  const mostRecentCompleted = priorUploads
    .filter((u) => u.status === "completed" && u.totalRows > 0)
    .sort((a, b) => b.seq - a.seq)[0];
  if (!mostRecentCompleted) {
    return { flagged: false, message: null, currentReviewRate, priorReviewRate: null };
  }

  const priorReviewRate = mostRecentCompleted.needsReview / mostRecentCompleted.totalRows;

  // Flag only a genuine jump, not routine variance — more than double
  // the prior rate AND the prior rate wasn't already high (a supplier
  // whose catalog is always mostly ambiguous doesn't get flagged every
  // single time).
  const flagged = priorReviewRate < 0.5 && currentReviewRate > priorReviewRate * 2 && currentReviewRate - priorReviewRate > 0.1;

  const message = flagged
    ? `This file proposes ${Math.round(currentReviewRate * 100)}% genuinely ambiguous/incomplete items requiring review (${
        preview.requiresReview
      } of ${preview.totalRows} rows) — this supplier's last completed upload was only ${Math.round(priorReviewRate * 100)}% ambiguous (${
        mostRecentCompleted.needsReview
      } of ${mostRecentCompleted.totalRows}). Confirm this file is actually from this supplier and the mapping is correct before continuing.`
    : null;

  return { flagged, message, currentReviewRate, priorReviewRate };
}
