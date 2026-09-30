// READ-ONLY. Faithfully replicates processSupplierUpload's REAL main
// per-row loop (pricing-process.ts lines ~246-620) against the actual
// Classic Wholesale spreadsheet, instrumented with per-substep cumulative
// timers, to find exactly what's slow -- as opposed to
// measure-baseline-matching-costs.ts and the Phase 1 batch-equivalence
// test, which only exercise matchSupplierRow/stepMatchPreviewBatch in
// isolation. This calls the SAME real functions processSupplierUpload
// calls, in the SAME order, including the ones outside pure matching:
// getUsdRate, findPreviousBySupplierItemIdentity (identity fallback),
// resolveEffectiveBrand/extractAttributes for auto-create eligibility,
// computeIdentitySignature. Zero writes -- reads getProducts/
// getAllReferenceProducts/getAliasesForSupplier, nothing else.
import fs from "fs";
import {
  parseSpreadsheetRaw,
  resolveHeaderRow,
  computeHeaderSignature,
  suggestColumnMapping,
  applyColumnMapping,
} from "../src/lib/pricing-parse";
import {
  matchSupplierRow,
  buildMasterCandidatePool,
  buildBrandBucketedPool,
  addToBrandBucketedPool,
  buildPreviousOfferIdentityIndex,
  findPreviousBySupplierItemIdentity,
  resolveEffectiveBrand,
  extractAttributes,
  extractReferenceProductAttributes,
  checkAutoCreateEligibility,
  computeIdentitySignature,
  isPlausibleBarcode,
  isValidProductRow,
  deriveOfferKey,
  type BrandBucketedPool,
} from "../src/lib/pricing-matching";
import { getUsdRate, convertToUsd } from "../src/lib/pricing-fx";
import { getProducts } from "../src/lib/db";
import { getAllReferenceProducts, getAliasesForSupplier } from "../src/lib/pricing-db";
import type { PricingReferenceProduct, SupplierAlias, SupplierOfferCurrent } from "../src/lib/pricing-types";

const SUPPLIER_ID = "sup_1790700359624_5oy1mu"; // real Classic Wholesale id, READ-ONLY here
const BATCH_REPORT_SIZE = 500;

async function main() {
  const filePath = process.argv[2] ?? "/tmp/classic-wholesale-export.xlsx";
  const buf = fs.readFileSync(filePath);
  const rawRows = parseSpreadsheetRaw(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const headerRes = resolveHeaderRow(rawRows, undefined, undefined);
  const headerRow = rawRows[headerRes.headerRowIndex];
  const headerSig = computeHeaderSignature(headerRow);
  const columnMap = suggestColumnMapping(headerRow);
  const dataRows = rawRows.slice(headerRes.headerRowIndex + 1);
  const rows = applyColumnMapping(dataRows, columnMap, headerSig);
  console.log(`headerRowIndex=${headerRes.headerRowIndex}, columnMap=${JSON.stringify(columnMap)}, rows=${rows.length}`);

  const [products, existingAliases, referenceProducts] = await Promise.all([
    getProducts(),
    getAliasesForSupplier(SUPPLIER_ID),
    getAllReferenceProducts(),
  ]);
  console.log(`products=${products.length}, existingAliases=${existingAliases.length}, referenceProducts=${referenceProducts.length}`);

  const previousOffers: Record<string, SupplierOfferCurrent> = {}; // brand-new supplier -- empty, exactly like production
  const candidateOffers: Record<string, SupplierOfferCurrent> = { ...previousOffers };
  const candidatePool: BrandBucketedPool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));
  const previousOfferIdentityIndex = buildPreviousOfferIdentityIndex(previousOffers);
  const newAliases: SupplierAlias[] = [];
  const mutableReferenceProducts = [...referenceProducts];

  // Cumulative per-substep timers.
  const t = {
    isValidProductRow: 0,
    matchSupplierRow: 0,
    getUsdRate: 0,
    aliasesConcat: 0,
    fallbackLookup: 0,
    effectiveBrandAndAttrs: 0,
    eligibilityAndSignature: 0,
    poolMutation: 0,
    objectConstruction: 0,
  };
  let pendingPersistSeq = 0;
  const PENDING_PLACEHOLDER_PREFIX = "pending:";

  let batchStart = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    let s = Date.now();
    const valid = isValidProductRow(row);
    t.isValidProductRow += Date.now() - s;
    if (!valid) continue;

    const offerKey = deriveOfferKey(row.supplierSku, row.description);

    s = Date.now();
    const aliasesSoFar = existingAliases.concat(newAliases);
    t.aliasesConcat += Date.now() - s;

    s = Date.now();
    const match = matchSupplierRow({ offerKey, ...row }, products, aliasesSoFar, mutableReferenceProducts, candidatePool);
    t.matchSupplierRow += Date.now() - s;

    s = Date.now();
    const rate = await getUsdRate(row.currency);
    t.getUsdRate += Date.now() - s;
    convertToUsd(row.price, rate?.rate ?? null);

    s = Date.now();
    let previous = candidateOffers[offerKey];
    if (!previous) {
      findPreviousBySupplierItemIdentity({ upc: row.upc, ean: row.ean, brand: row.brand, description: row.description }, previousOfferIdentityIndex);
    }
    t.fallbackLookup += Date.now() - s;

    let finalReviewStatus = match.reviewStatus;
    const finalReferenceProductId = match.referenceProductId ?? (previous?.referenceProductId ?? null);

    if (finalReviewStatus === "new_candidate" && !finalReferenceProductId) {
      s = Date.now();
      const plausibleUpc = isPlausibleBarcode(row.upc.trim().toUpperCase()) ? row.upc.trim() : "";
      const plausibleEan = isPlausibleBarcode(row.ean.trim().toUpperCase()) ? row.ean.trim() : "";
      const effectiveBrand = resolveEffectiveBrand(row, products, mutableReferenceProducts);
      const rowAttrs = extractAttributes(`${row.brand} ${row.description}`, effectiveBrand);
      t.effectiveBrandAndAttrs += Date.now() - s;

      s = Date.now();
      const eligibility = checkAutoCreateEligibility(rowAttrs, Boolean(plausibleUpc || plausibleEan));
      let signature = "";
      if (eligibility.eligible) signature = computeIdentitySignature(rowAttrs);
      t.eligibilityAndSignature += Date.now() - s;

      if (eligibility.eligible) {
        const placeholderId = `${PENDING_PLACEHOLDER_PREFIX}${pendingPersistSeq++}`;
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
          createdFromSupplierId: SUPPLIER_ID,
          createdFromUploadId: null,
          createdFromOfferKey: offerKey,
        };
        void signature;
        s = Date.now();
        const placeholderRecord: PricingReferenceProduct = { id: placeholderId, ...newRecordInput, createdAt: new Date().toISOString() };
        mutableReferenceProducts.push(placeholderRecord);
        addToBrandBucketedPool(candidatePool, {
          productId: null,
          referenceProductId: placeholderId,
          attrs: extractReferenceProductAttributes(placeholderRecord),
          upc: placeholderRecord.upc,
          ean: placeholderRecord.ean,
        });
        t.poolMutation += Date.now() - s;
      }
    }

    s = Date.now();
    // Rough stand-in for the two object literals (snapshot + offer)
    // processSupplierUpload builds per row -- allocation only, no I/O.
    const _snapshotStandIn = { ...row, offerKey, matchType: match.matchType, reviewStatus: finalReviewStatus };
    const _offerStandIn = { ...row, offerKey, matchType: match.matchType, reviewStatus: finalReviewStatus };
    void _snapshotStandIn;
    void _offerStandIn;
    t.objectConstruction += Date.now() - s;

    if ((i + 1) % BATCH_REPORT_SIZE === 0 || i === rows.length - 1) {
      const elapsed = Date.now() - batchStart;
      console.log(`Rows 1-${i + 1}: batch-window ${elapsed}ms | cumulative: isValidProductRow=${t.isValidProductRow}ms matchSupplierRow=${t.matchSupplierRow}ms getUsdRate=${t.getUsdRate}ms aliasesConcat=${t.aliasesConcat}ms fallbackLookup=${t.fallbackLookup}ms effectiveBrandAndAttrs=${t.effectiveBrandAndAttrs}ms eligibilityAndSignature=${t.eligibilityAndSignature}ms poolMutation=${t.poolMutation}ms objectConstruction=${t.objectConstruction}ms`);
      batchStart = Date.now();
    }
  }

  const total = Object.values(t).reduce((a, b) => a + b, 0);
  console.log("\n=== TOTAL BREAKDOWN ===");
  for (const [k, v] of Object.entries(t)) console.log(`  ${k}: ${v}ms (${((v / total) * 100).toFixed(1)}%)`);
  console.log(`  SUM: ${total}ms`);
}
main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
