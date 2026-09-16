import { getProducts } from "./db";
import {
  commitGeneration,
  createUpload,
  getAliasesForSupplier,
  getAllReferenceProducts,
  getCommittedOffers,
  getOrCreateReferenceProductByIdentity,
  getReferenceProduct,
  getUpload,
  markUploadFailed,
  newId,
  updateUploadProgress,
  writeCandidateGeneration,
  writeSnapshotsBatch,
  type OffersByProductOp,
  type OffersByReferenceProductOp,
} from "./pricing-db";
import {
  checkAutoCreateEligibility,
  computeIdentitySignature,
  deriveOfferKey,
  extractAttributes,
  isPlausibleBarcode,
  isValidProductRow,
  matchSupplierRow,
  findPreviousBySupplierItemIdentity,
  type MatchPreviewSummary,
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
  SupplierAlias,
  SupplierOfferCurrent,
  SupplierOfferSnapshot,
  SupplierPriceUpload,
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
// ---------------------------------------------------------------------

const PROGRESS_UPDATE_INTERVAL = 200;

export async function processSupplierUpload(input: {
  supplierId: string;
  filename: string;
  blobUrl: string;
  uploadType: "full" | "partial";
  /** The EXACT mapping the operator confirmed in Preview — header row,
   *  columns, and the header text they were looking at when they
   *  approved it. This function never detects or suggests a header row
   *  or column map itself; it only verifies this confirmed
   *  configuration still applies to the freshly-refetched file. See
   *  verifyHeaderSignature below. */
  headerRowIndex: number;
  headerSignature: string[];
  columnMap: SupplierColumnMapping["columnMap"];
  /** Retry a specific FAILED upload by id instead of starting a new one.
   *  Reuses the same id AND the same seq — a genuine retry re-stages
   *  everything fresh (deterministic snapshot keys mean this can never
   *  duplicate history) and competes for the commit with the SAME
   *  ordering priority it originally had, rather than jumping the queue
   *  with a brand-new, higher seq the way an unrelated new upload would. */
  retryUploadId?: string;
}): Promise<SupplierPriceUpload> {
  // The upload record is created FIRST, before the file is even fetched
  // — so a failure at ANY point (can't download the blob, can't parse
  // it, a bad row) is always visible as a real "failed" record, never
  // silent. Fetching/parsing used to happen in the API route before
  // this function was ever called, which meant those failures left no
  // trace at all — fixed by moving that work inside this try block.
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
    const blobRes = await fetch(input.blobUrl);
    if (!blobRes.ok) throw new Error("Could not download the uploaded file.");
    const rawRows = parseSpreadsheetRaw(await blobRes.arrayBuffer());
    if (rawRows.length === 0) throw new Error("This file appears to be empty.");

    // Verify — never re-detect. If the confirmed header row no longer
    // holds the confirmed header text (the file changed, or a stale/
    // mismatched request), refuse rather than guessing a new mapping
    // the operator never saw in Preview.
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
    // anything is written — never trust that the disabled Process
    // button alone kept a bad mapping from reaching this point (stale
    // browser state, a UI bug, a changed file, or a misfired retry
    // could all otherwise bypass it).
    const sanity = computeSanityChecks(rows);
    if (!sanity.ok) {
      throw new Error(`Confirmed mapping no longer passes validation — return to Preview and review the spreadsheet mapping. (${sanity.warnings.join(" ")})`);
    }

    await updateUploadProgress(upload.id, { totalRows: rows.length });

    const [products, existingAliases, previousOffers, referenceProducts] = await Promise.all([
      getProducts(),
      getAliasesForSupplier(input.supplierId),
      getCommittedOffers(input.supplierId),
      // Mutable for the duration of this upload — a row that auto-creates
      // (or reuses, via the identity get-or-create) a Master Product is
      // pushed in immediately, so a LATER row in this SAME file for the
      // same physical item sees it through the normal exact-match path
      // instead of independently re-running auto-creation (plan §4/§5b).
      getAllReferenceProducts(),
    ]);

    const candidateOffers: Record<string, SupplierOfferCurrent> = { ...previousOffers };
    const touchedKeys = new Set<string>();
    const newAliases: SupplierAlias[] = [];
    const offersByProductOps: OffersByProductOp[] = [];
    const offersByReferenceProductOps: OffersByReferenceProductOp[] = [];
    const snapshots: SupplierOfferSnapshot[] = [];
    let autoMatched = 0;
    let autoCreated = 0;
    let needsReview = 0;
    const newCandidates = 0; // legacy — always 0 under the corrected model, see SupplierPriceUpload's own doc comment
    let notAProduct = 0;
    const nowIso = new Date().toISOString();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Non-product rows (headers/notes/totals/shipping/blank/category
      // lines) are classified BEFORE any matching runs — they never
      // enter Match Review, are never auto-created, and only ever show
      // up as the nonProductRows import-summary count. Still recorded
      // as a snapshot for audit ("here's exactly why row 47 was
      // skipped"), same as every other row.
      if (!isValidProductRow(row)) {
        const offerKey = deriveOfferKey(row.supplierSku, row.description);
        notAProduct++;
        snapshots.push({
          id: newId("offersnap"),
          uploadId: upload.id,
          rowIndex: i,
          supplierId: input.supplierId,
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
          uploadedAt: nowIso,
        });
        touchedKeys.add(offerKey);
        candidateOffers[offerKey] = {
          supplierId: input.supplierId,
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
          lastUploadId: upload.id,
          uploadedAt: nowIso,
        };
        if ((i + 1) % PROGRESS_UPDATE_INTERVAL === 0) {
          await updateUploadProgress(upload.id, { processedRows: i + 1 });
        }
        continue;
      }

      const offerKey = deriveOfferKey(row.supplierSku, row.description);
      const aliasesSoFar = existingAliases.concat(newAliases);
      const match = matchSupplierRow(
        { offerKey, supplierSku: row.supplierSku, description: row.description, brand: row.brand, upc: row.upc, ean: row.ean },
        products,
        aliasesSoFar,
        referenceProducts
      );

      const rate = await getUsdRate(row.currency);
      const priceUsd = convertToUsd(row.price, rate?.rate ?? null);

      // Direct offerKey lookup first — the normal, fast path, confirmed
      // stable across real repeat uploads (see the Match Review audit).
      // Only when that misses does the conservative identity fallback
      // try to reconnect this row to its OWN prior supplier-item history
      // under a different offerKey (e.g. the supplier reformatted their
      // SKU column) — see findPreviousBySupplierItemIdentity's own
      // comments for exactly what it will and won't reconnect.
      let previous = candidateOffers[offerKey];
      let reconnectedViaFallback = false;
      if (!previous) {
        const fallback = findPreviousBySupplierItemIdentity(
          { upc: row.upc, ean: row.ean, brand: row.brand, description: row.description },
          candidateOffers
        );
        if (fallback) {
          previous = fallback;
          reconnectedViaFallback = true;
        }
      }

      // Carry-forward decision, applied on top of matchSupplierRow's own
      // fresh result — never the other way around, so a genuinely
      // stronger new signal (e.g. a UPC now cleanly resolves) always
      // wins over stale carried-forward state:
      //   - an intentionally "ignored" decision survives a re-upload
      //     unless today's fresh match is a clean auto_matched (real new
      //     evidence appeared);
      //   - otherwise, if today's fresh match found nothing
      //     (new_candidate) AND the identity fallback reconnected this
      //     row to a previously-resolved item, adopt that prior
      //     resolution rather than treating a reformatted-SKU row as
      //     brand new.
      let finalReviewStatus = match.reviewStatus;
      let finalProductId = match.productId;
      let finalCandidateProductId = match.candidateProductId;
      let finalCandidateReferenceProductId = match.candidateReferenceProductId;
      let finalCompetingCandidates = match.competingCandidates;
      let finalMatchType = match.matchType;
      let finalMatchConfidence = match.matchConfidence;
      // referenceProductId (a Pricing/Ordering "tracked item" link, set
      // only by Match Review's own Track/Link actions or by auto-creation
      // below) is completely independent of the fresh match result above
      // — it always starts from whatever this offerKey already carried.
      let finalReferenceProductId = previous?.referenceProductId ?? null;

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
        // recomputed fresh, never persisted state (see its own comment on
        // SupplierOfferCurrent); a fallback-reconnected row simply has none.
        finalCompetingCandidates = undefined;
        finalMatchType = previous.matchType;
        finalMatchConfidence = previous.matchConfidence;
      }

      // "No — Not a Match" carry-forward: an operator explicitly rejected
      // THIS exact candidate for THIS exact supplier item before — never
      // re-suggest it. Applied last, on top of whichever branch above
      // produced the current candidate, so it catches a rejected product
      // resurfacing via either the normal match or the identity fallback.
      // Blocks only this specific productId — a different candidate (via
      // a stronger real signal, e.g. a UPC now present) is unaffected.
      // The row STAYS needs_review with the candidate cleared (never
      // demoted to "new_candidate" limbo — there is no such limbo under
      // the corrected model): a rejected guess doesn't resolve the
      // underlying ambiguity, it just means "not that one," so the row
      // is still exactly what it was — a genuine Match Review item — an
      // operator can search/link/track it manually, or a stronger signal
      // on a later upload can resolve it automatically.
      const rejectedIds = previous?.rejectedCandidateProductIds ?? [];
      if (finalCandidateProductId && rejectedIds.includes(finalCandidateProductId)) {
        finalCandidateProductId = null;
        finalMatchConfidence = null;
      }

      // Corrected operating model: "no existing match" is never itself
      // an end state. Every row that reaches here (matchSupplierRow
      // found nothing) resolves immediately into exactly one of three
      // real outcomes — no purgatory in between:
      //
      //  1. Already tracked (finalReferenceProductId set from a prior
      //     "Track for Pricing" on an earlier generation) — that was
      //     already a deliberate human identity decision; it's matched,
      //     full stop, not left sitting unresolved just because this
      //     row's own auto-creation branch never ran for it.
      //  2. Structurally complete (checkAutoCreateEligibility passes) —
      //     auto-create the Master Product and attach the offer. This is
      //     expected, routine catalog growth, never an error or a queue.
      //  3. Genuinely incomplete/ambiguous (e.g. "DIOR SAUVAGE 100ML",
      //     no concentration stated, no authoritative UPC) — Match
      //     Review, because the exact SKU truly cannot be determined
      //     yet. Auto-creating here would lock in a guess.
      if (finalReviewStatus === "new_candidate") {
        if (finalReferenceProductId) {
          finalReviewStatus = "auto_matched";
          finalMatchType = "manual";
          finalMatchConfidence = 1;
          finalCandidateProductId = null;
          finalCandidateReferenceProductId = null;
          finalCompetingCandidates = undefined;
        } else {
          const rowAttrs = extractAttributes(`${row.brand} ${row.description}`, row.brand);
          const eligibility = checkAutoCreateEligibility(rowAttrs);
          if (!eligibility.eligible) {
            // Genuine ambiguity/incompleteness — a real Match Review
            // case, not "new_candidate" limbo.
            finalReviewStatus = "needs_review";
            finalMatchType = "unmatched";
            finalMatchConfidence = null;
            finalCandidateProductId = null;
            finalCandidateReferenceProductId = null;
            finalCompetingCandidates = undefined;
          } else {
            const signature = computeIdentitySignature(rowAttrs);
            // A supplier's own placeholder text ("NO BARCODE" etc.) must
            // never become a stored identity pointer — it isn't a real,
            // uniquely-shared barcode, so treat it as absent here, same
            // as everywhere else upc/ean is used as an identifier.
            const plausibleUpc = isPlausibleBarcode(row.upc.trim().toUpperCase()) ? row.upc.trim() : "";
            const plausibleEan = isPlausibleBarcode(row.ean.trim().toUpperCase()) ? row.ean.trim() : "";
            const getOrCreateResult = await getOrCreateReferenceProductByIdentity(
              { upc: plausibleUpc, ean: plausibleEan, signature },
              {
                brand: row.brand.trim(),
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
                createdFromSupplierId: input.supplierId,
                createdFromUploadId: upload.id,
                createdFromOfferKey: offerKey,
              }
            );

            if (getOrCreateResult.status === "conflict") {
              // UPC/EAN and the structural signature disagree on which
              // existing Master Product this is — never auto-picked,
              // merged, or auto-linked. Route to needs_review with every
              // conflicting identity shown for a human to resolve.
              finalReviewStatus = "needs_review";
              finalMatchType = "unmatched";
              finalMatchConfidence = null;
              finalCandidateProductId = null;
              finalCandidateReferenceProductId = null;
              finalCompetingCandidates = getOrCreateResult.ids.map((id) => ({ productId: null, referenceProductId: id }));
            } else {
              finalReferenceProductId = getOrCreateResult.id;
              finalReviewStatus = "auto_matched";
              finalMatchType = "auto_created";
              finalMatchConfidence = 1;
              finalCandidateProductId = null;
              finalCandidateReferenceProductId = null;
              finalCompetingCandidates = undefined;
              // Make this visible to every LATER row in this same upload
              // — whether genuinely brand-new or reused from an existing
              // record — so a repeat of the same physical item later in
              // this file takes the normal exact-match path instead of
              // hitting get-or-create a second time for no reason.
              if (getOrCreateResult.status === "created") {
                referenceProducts.push(getOrCreateResult.product);
              } else {
                const reused = await getReferenceProduct(getOrCreateResult.id);
                if (reused) referenceProducts.push(reused);
              }
            }
          }
        }
      }

      // Whether a genuinely-ambiguous item is flagged for the ACTIVE
      // review queue is completely independent of the fresh match above
      // — it only ever changes via an explicit "Send for Review" or a
      // workflow's requestIdentityResolution call (pricing-product-
      // linking.ts), never by re-matching. Carried forward across
      // re-uploads while still needs_review (a flag doesn't silently
      // vanish on the next price list); cleared the instant the row
      // resolves to anything else, matched or not.
      const finalReviewRequestedAt = finalReviewStatus === "needs_review" ? (previous?.reviewRequestedAt ?? null) : null;

      snapshots.push({
        id: newId("offersnap"),
        uploadId: upload.id,
        rowIndex: i,
        supplierId: input.supplierId,
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
        uploadedAt: nowIso,
      });

      touchedKeys.add(offerKey);
      const nextOffer: SupplierOfferCurrent = {
        supplierId: input.supplierId,
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
        // Carried forward exactly like productId — re-uploading a
        // supplier's sheet must never silently wipe out a tracked link an
        // operator set via "Track for Pricing" / "Link to tracked item"
        // on a prior generation — and now also set fresh by auto-creation
        // above when this row's identity is genuinely new.
        referenceProductId: finalReferenceProductId,
        rejectedCandidateProductIds: rejectedIds,
        reviewRequestedAt: finalReviewRequestedAt,
        currentlyListed: true,
        lastUploadId: upload.id,
        uploadedAt: nowIso,
      };
      candidateOffers[offerKey] = nextOffer;

      // The reverse index is only ever keyed by THIS row's actual
      // offerKey. A fallback-reconnected `previous` came from a
      // DIFFERENT offerKey (the row's own prior identity, before the
      // SKU reformatted) — that old key's own index membership is
      // untouched here (it simply stops being touched by future
      // uploads, same as any other superseded offerKey), so there is
      // nothing to SREM for it under the NEW key; only a fresh SADD (if
      // this row now resolves to a product) applies.
      const member = `${input.supplierId}::${offerKey}`;
      const priorSameKeyProductId = reconnectedViaFallback ? null : (previous?.productId ?? null);
      if (priorSameKeyProductId && priorSameKeyProductId !== finalProductId) {
        offersByProductOps.push({ op: "SREM", productId: priorSameKeyProductId, member });
      }
      if (finalProductId && priorSameKeyProductId !== finalProductId) {
        offersByProductOps.push({ op: "SADD", productId: finalProductId, member });
      }

      // Mirrors the offers_by_product reverse-index maintenance above,
      // for Master/Reference Products — same "only this offerKey's own
      // prior link, only if it actually changed" logic.
      const priorSameKeyReferenceProductId = reconnectedViaFallback ? null : (previous?.referenceProductId ?? null);
      if (priorSameKeyReferenceProductId && priorSameKeyReferenceProductId !== finalReferenceProductId) {
        offersByReferenceProductOps.push({ op: "SREM", referenceProductId: priorSameKeyReferenceProductId, member });
      }
      if (finalReferenceProductId && priorSameKeyReferenceProductId !== finalReferenceProductId) {
        offersByReferenceProductOps.push({ op: "SADD", referenceProductId: finalReferenceProductId, member });
      }

      // A newly-confirmed high-confidence match (not already a learned
      // alias) becomes one — so this exact supplier SKU/description
      // never asks again. Skip if an identical alias already exists
      // (repeat uploads of an already-aliased row shouldn't pile up
      // duplicate alias records).
      if (
        finalReviewStatus === "auto_matched" &&
        finalMatchType !== "alias" &&
        finalProductId &&
        !aliasesSoFar.some((a) => a.offerKey === offerKey && a.productId === finalProductId)
      ) {
        newAliases.push({
          id: newId("alias"),
          supplierId: input.supplierId,
          offerKey,
          productId: finalProductId,
          createdAt: nowIso,
          source: "auto_high_confidence",
        });
      }

      // A fallback-reconnected identity is durable evidence too — write
      // an alias for the NEW offerKey so the next upload (which will
      // keep using this same reformatted SKU) takes the normal, fast
      // direct/alias path without needing the fallback again.
      if (
        reconnectedViaFallback &&
        finalProductId &&
        !aliasesSoFar.some((a) => a.offerKey === offerKey && a.productId === finalProductId)
      ) {
        newAliases.push({
          id: newId("alias"),
          supplierId: input.supplierId,
          offerKey,
          productId: finalProductId,
          createdAt: nowIso,
          source: "auto_high_confidence",
        });
      }

      // "new_candidate" is provably unreachable here — every path above
      // that could produce it reassigns finalReviewStatus to
      // auto_matched/needs_review before this point (TypeScript's own
      // control-flow narrowing confirms it); newCandidates therefore
      // stays 0 for every upload processed under the corrected model,
      // exactly as its own deprecated doc comment says.
      if (finalReviewStatus === "auto_matched") {
        if (finalMatchType === "auto_created") autoCreated++;
        else autoMatched++;
      } else if (finalReviewStatus !== "ignored") {
        needsReview++; // needs_review, alias_conflict, barcode_conflict — "ignored" is deliberately none of these three
      }

      if ((i + 1) % PROGRESS_UPDATE_INTERVAL === 0) {
        await updateUploadProgress(upload.id, { processedRows: i + 1 });
      }
    }

    // Full upload: anything from the previous generation this file
    // never mentioned is no longer listed — kept, never deleted, still
    // discoverable and still carrying its full history.
    if (input.uploadType === "full") {
      for (const [offerKey, offer] of Object.entries(candidateOffers)) {
        if (!touchedKeys.has(offerKey) && offer.currentlyListed) {
          candidateOffers[offerKey] = { ...offer, currentlyListed: false };
        }
      }
    }

    const generationId = newId("gen");
    await writeCandidateGeneration(input.supplierId, generationId, candidateOffers);
    await writeSnapshotsBatch(snapshots);

    const finishedUpload: SupplierPriceUpload = {
      ...upload,
      status: "completed",
      processedRows: rows.length,
      autoMatched,
      autoCreated,
      needsReview,
      newCandidates,
      notAProduct,
      completedAt: new Date().toISOString(),
    };

    const commitResult = await commitGeneration({
      supplierId: input.supplierId,
      uploadId: upload.id,
      seq: upload.seq,
      generationId,
      finishedUpload,
      newAliases: existingAliases.concat(newAliases),
      offersByProductOps,
      offersByReferenceProductOps,
    });

    // STALE_GENERATION: this upload fully and correctly processed every
    // row, but a newer upload (higher seq) already committed first — per
    // the ordering guard, the script returns before writing anything
    // (including the upload record itself), so persist the completed
    // state here instead. The generation/snapshots it built are real and
    // retained in history but deliberately never made current; "is this
    // the live one" is a read-time comparison against the supplier's
    // current committed seq, not a separate stored flag — same
    // derive-don't-duplicate principle used elsewhere in this codebase.
    // On a real commit ("OK"), the script already persisted this exact
    // record, so there's nothing left to do.
    if (commitResult === "STALE_GENERATION") {
      await updateUploadProgress(upload.id, finishedUpload);
    }
    return finishedUpload;
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
