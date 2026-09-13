import { getProducts } from "./db";
import {
  commitGeneration,
  createUpload,
  getAliasesForSupplier,
  getCommittedOffers,
  getUpload,
  markUploadFailed,
  newId,
  updateUploadProgress,
  writeCandidateGeneration,
  writeSnapshotsBatch,
  type OffersByProductOp,
} from "./pricing-db";
import { deriveOfferKey, matchSupplierRow, findPreviousBySupplierItemIdentity } from "./pricing-matching";
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

    const [products, existingAliases, previousOffers] = await Promise.all([
      getProducts(),
      getAliasesForSupplier(input.supplierId),
      getCommittedOffers(input.supplierId),
    ]);

    const candidateOffers: Record<string, SupplierOfferCurrent> = { ...previousOffers };
    const touchedKeys = new Set<string>();
    const newAliases: SupplierAlias[] = [];
    const offersByProductOps: OffersByProductOp[] = [];
    const snapshots: SupplierOfferSnapshot[] = [];
    let autoMatched = 0;
    let needsReview = 0;
    let newCandidates = 0;
    const nowIso = new Date().toISOString();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const offerKey = deriveOfferKey(row.supplierSku, row.description);
      const aliasesSoFar = existingAliases.concat(newAliases);
      const match = matchSupplierRow(
        { offerKey, supplierSku: row.supplierSku, description: row.description, brand: row.brand, upc: row.upc, ean: row.ean },
        products,
        aliasesSoFar
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
      let finalMatchType = match.matchType;
      let finalMatchConfidence = match.matchConfidence;

      if (previous?.reviewStatus === "ignored" && match.reviewStatus !== "auto_matched") {
        finalReviewStatus = "ignored";
        finalProductId = null;
        finalCandidateProductId = null;
        finalMatchType = "unmatched";
        finalMatchConfidence = null;
      } else if (reconnectedViaFallback && match.reviewStatus === "new_candidate" && previous) {
        finalReviewStatus = previous.reviewStatus;
        finalProductId = previous.productId;
        finalCandidateProductId = previous.candidateProductId;
        finalMatchType = previous.matchType;
        finalMatchConfidence = previous.matchConfidence;
      }

      // "No — Not a Match" carry-forward: an operator explicitly rejected
      // THIS exact candidate for THIS exact supplier item before — never
      // re-suggest it. Applied last, on top of whichever branch above
      // produced the current candidate, so it catches a rejected product
      // resurfacing via either the normal match or the identity fallback.
      // Blocks only this specific productId — a different candidate (via
      // a stronger real signal, e.g. a UPC now present) is unaffected
      // since finalReviewStatus is only ever downgraded here, never used
      // to suppress an actual confirmed productId (needs_review never
      // carries one — see rejectSuggestedCandidate's own comment).
      const rejectedIds = previous?.rejectedCandidateProductIds ?? [];
      if (finalCandidateProductId && rejectedIds.includes(finalCandidateProductId)) {
        finalCandidateProductId = null;
        if (finalReviewStatus === "needs_review") finalReviewStatus = "new_candidate";
        finalMatchConfidence = null;
      }

      snapshots.push({
        id: newId("offersnap"),
        uploadId: upload.id,
        rowIndex: i,
        supplierId: input.supplierId,
        offerKey,
        raw: row,
        productId: finalProductId,
        candidateProductId: finalCandidateProductId,
        matchType: finalMatchType,
        matchConfidence: finalMatchConfidence,
        reviewStatus: finalReviewStatus,
        referenceProductId: previous?.referenceProductId ?? null,
        rejectedCandidateProductIds: rejectedIds,
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
        matchType: finalMatchType,
        matchConfidence: finalMatchConfidence,
        reviewStatus: finalReviewStatus,
        // Carried forward exactly like productId — re-uploading a
        // supplier's sheet must never silently wipe out a tracked link
        // an operator set via "Track for Pricing" / "Link to tracked
        // item" on a prior generation.
        referenceProductId: previous?.referenceProductId ?? null,
        rejectedCandidateProductIds: rejectedIds,
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

      if (finalReviewStatus === "auto_matched") autoMatched++;
      else if (finalReviewStatus === "new_candidate") newCandidates++;
      else if (finalReviewStatus !== "ignored") needsReview++; // needs_review, alias_conflict, barcode_conflict — "ignored" is deliberately none of these three

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
      needsReview,
      newCandidates,
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
