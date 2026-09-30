// READ-ONLY isolated test. Proves the resumable processSupplierUploadBatch
// loop produces BYTE-IDENTICAL results to running the same rows through
// one continuous pass — the same equivalence discipline
// test-match-preview-batch-equivalence.ts already established for
// parse-preview/match-batch, now applied to /api/pricing/process's main
// loop. Calls the SAME exported processRow function both ways — the only
// difference between "single pass" and "batched" is whether state is
// carried forward in memory or round-tripped through JSON (Map -> plain
// object, Set -> array, and back) between chunks, exactly like
// processSupplierUploadBatch's session does between real HTTP requests.
// This also directly exercises the real cross-batch dedup path: the real
// Classic Wholesale file has genuine in-file repeats whose FIRST
// occurrence creates a placeholder in one batch and whose LATER
// occurrence(s) structurally match that same placeholder in a
// DIFFERENT batch.
//
// Never writes anything — only reads getProducts()/getAllReferenceProducts()
// (real, read-only) and exercises pure in-memory logic otherwise.
import assert from "assert";
import fs from "fs";
import {
  createEmptyRowProcessingState,
  processRow,
  type RowProcessingContext,
  type RowProcessingState,
} from "../src/lib/pricing-process";
import {
  buildBrandBucketedPool,
  buildMasterCandidatePool,
  buildPreviousOfferIdentityIndex,
} from "../src/lib/pricing-matching";
import { parseSpreadsheetRaw, resolveHeaderRow, computeHeaderSignature, suggestColumnMapping, applyColumnMapping } from "../src/lib/pricing-parse";
import { getProducts } from "../src/lib/db";
import { getAllReferenceProducts } from "../src/lib/pricing-db";
import type { PricingReferenceProduct, SupplierRawRow } from "../src/lib/pricing-types";
import type { Product } from "../src/lib/types";

const SUPPLIER_ID = "sup_TEST_EQUIVALENCE_ONLY"; // never written anywhere — pure in-memory test

interface SerializableState {
  candidateOffers: RowProcessingState["candidateOffers"];
  snapshots: RowProcessingState["snapshots"];
  newAliases: RowProcessingState["newAliases"];
  offersByProductOps: RowProcessingState["offersByProductOps"];
  offersByReferenceProductOps: RowProcessingState["offersByReferenceProductOps"];
  autoMatched: number;
  autoCreated: number;
  needsReview: number;
  notAProduct: number;
  pendingPersistSeq: number;
  pendingPersists: RowProcessingState["pendingPersists"];
  placeholderUsage: Record<string, { rowIndex: number; offerKey: string }[]>;
}

function toSerializable(state: RowProcessingState): SerializableState {
  // JSON round-trip on the whole thing (not just the Map/Set conversion)
  // to also prove ordinary serialization doesn't perturb anything (e.g.
  // undefined vs. missing keys, Date-like strings).
  return JSON.parse(
    JSON.stringify({
      candidateOffers: state.candidateOffers,
      snapshots: state.snapshots,
      newAliases: state.newAliases,
      offersByProductOps: state.offersByProductOps,
      offersByReferenceProductOps: state.offersByReferenceProductOps,
      autoMatched: state.autoMatched,
      autoCreated: state.autoCreated,
      needsReview: state.needsReview,
      notAProduct: state.notAProduct,
      pendingPersistSeq: state.pendingPersistSeq,
      pendingPersists: state.pendingPersists,
      placeholderUsage: Object.fromEntries(state.placeholderUsage),
    })
  );
}

function fromSerializable(s: SerializableState): RowProcessingState {
  return {
    candidateOffers: s.candidateOffers,
    touchedKeys: new Set(Object.keys(s.candidateOffers)),
    newAliases: s.newAliases,
    offersByProductOps: s.offersByProductOps,
    offersByReferenceProductOps: s.offersByReferenceProductOps,
    snapshots: s.snapshots,
    autoMatched: s.autoMatched,
    autoCreated: s.autoCreated,
    needsReview: s.needsReview,
    notAProduct: s.notAProduct,
    pendingPersistSeq: s.pendingPersistSeq,
    pendingPersists: s.pendingPersists,
    placeholderUsage: new Map(Object.entries(s.placeholderUsage)),
  };
}

// touchedKeys is reconstructed from candidateOffers' own keys above —
// valid because every row that touches candidateOffers[offerKey] adds
// that SAME offerKey to touchedKeys in lockstep (see processRow), so the
// two sets are always identical for a supplier with no pre-existing
// previousOffers (true for this test's synthetic supplier id).

// Strips every field whose value is inherently wall-clock-dependent
// (real current time at the moment each run happened to execute, never
// part of a matching/auto-create DECISION) — recursively, regardless of
// nesting, via a JSON.stringify replacer. `id` (snapshot/alias ids) is
// `newId()`-derived — timestamp+random, same non-determinism, same
// reason to strip. `pendingPersists[].newRecordInput.createdFromUploadId`
// and similar identifiers are real decision data and are NOT touched.
const NON_DETERMINISTIC_FIELDS = new Set(["id", "uploadedAt", "fxRateTimestamp"]);
function stripNonDeterministicIds<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, val) => (NON_DETERMINISTIC_FIELDS.has(key) ? undefined : val)));
}

function buildContext(products: Product[], referenceProducts: PricingReferenceProduct[], pendingPersists: RowProcessingState["pendingPersists"]): RowProcessingContext {
  const nowIso = new Date().toISOString();
  const mutableReferenceProducts = [...referenceProducts];
  for (const p of pendingPersists) {
    mutableReferenceProducts.push({ id: p.placeholderId, ...p.newRecordInput, createdAt: nowIso });
  }
  const candidatePool = buildBrandBucketedPool(buildMasterCandidatePool(products, mutableReferenceProducts));
  return {
    supplierId: SUPPLIER_ID,
    uploadId: "upl_test_equivalence",
    nowIso,
    products,
    existingAliases: [],
    referenceProducts: mutableReferenceProducts,
    candidatePool,
    previousOfferIdentityIndex: buildPreviousOfferIdentityIndex({}),
  };
}

async function runSinglePass(rows: SupplierRawRow[], products: Product[], referenceProducts: PricingReferenceProduct[]): Promise<SerializableState> {
  const ctx = buildContext(products, referenceProducts, []);
  const state = createEmptyRowProcessingState();
  for (let i = 0; i < rows.length; i++) {
    await processRow(rows[i], i, ctx, state);
  }
  return toSerializable(state);
}

async function runBatched(rows: SupplierRawRow[], products: Product[], referenceProducts: PricingReferenceProduct[], batchSize: number): Promise<SerializableState> {
  let serialized: SerializableState = {
    candidateOffers: {},
    snapshots: [],
    newAliases: [],
    offersByProductOps: [],
    offersByReferenceProductOps: [],
    autoMatched: 0,
    autoCreated: 0,
    needsReview: 0,
    notAProduct: 0,
    pendingPersistSeq: 0,
    pendingPersists: [],
    placeholderUsage: {},
  };
  for (let start = 0; start < rows.length; start += batchSize) {
    // Round-trip through JSON on every batch boundary — exactly what
    // Redis get/set does for the real session.
    const state = fromSerializable(JSON.parse(JSON.stringify(serialized)));
    // Rebuilt fresh every batch, exactly like processSupplierUploadBatch.
    const ctx = buildContext(products, referenceProducts, state.pendingPersists);
    const end = Math.min(start + batchSize, rows.length);
    for (let i = start; i < end; i++) {
      await processRow(rows[i], i, ctx, state);
    }
    serialized = toSerializable(state);
  }
  return serialized;
}

async function main() {
  const [products, referenceProducts] = await Promise.all([getProducts(), getAllReferenceProducts()]);

  let passed = 0;
  let failed = 0;
  async function check(name: string, rows: SupplierRawRow[], batchSize: number) {
    const single = stripNonDeterministicIds(await runSinglePass(rows, products, referenceProducts));
    const batched = stripNonDeterministicIds(await runBatched(rows, products, referenceProducts, batchSize));
    try {
      assert.deepStrictEqual(batched, single, `${name}: batched output did not match single-pass output`);
      console.log(`PASS: ${name} (batchSize=${batchSize}, rows=${rows.length})`);
      passed++;
    } catch (err) {
      console.log(`FAIL: ${name}`);
      console.log(err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  // --- 1. Small synthetic mix: non-product, ambiguous, known-brand
  // match, unrecognized-brand auto-create, all near a batch boundary. ---
  const syntheticRows: SupplierRawRow[] = [
    { supplierSku: "", description: "TOTAL", brand: "", quantity: null, price: 0, currency: "USD", upc: "", ean: "", category: "" },
    { supplierSku: "M1", description: "Dior Sauvage 100ML", brand: "Dior", quantity: 5, price: 50, currency: "USD", upc: "", ean: "", category: "" },
    { supplierSku: "M2", description: "ZzqEquivHouseAlpha Fragrance 100ML SPRAY", brand: "ZzqEquivHouseAlpha", quantity: 5, price: 40, currency: "USD", upc: "", ean: "", category: "" },
    { supplierSku: "M3", description: "ZzqEquivHouseAlpha Fragrance 100ML SPRAY", brand: "ZzqEquivHouseAlpha", quantity: 3, price: 40, currency: "USD", upc: "", ean: "", category: "" }, // in-file repeat of M2
    { supplierSku: "", description: "SHIPPING", brand: "", quantity: null, price: 0, currency: "USD", upc: "", ean: "", category: "" },
    { supplierSku: "M4", description: "Chanel No 5 EDP 100ML", brand: "Chanel", quantity: 2, price: 90, currency: "USD", upc: "", ean: "", category: "" },
    { supplierSku: "M5", description: "ZzqEquivHouseAlpha Fragrance 100ML SPRAY", brand: "ZzqEquivHouseAlpha", quantity: 1, price: 40, currency: "USD", upc: "", ean: "", category: "" }, // 3rd repeat, later still
  ];
  await check("synthetic mix incl. in-file repeats, batch=2", syntheticRows, 2);
  await check("synthetic mix incl. in-file repeats, batch=1", syntheticRows, 1);
  await check("synthetic mix incl. in-file repeats, batch=1000 (single batch)", syntheticRows, 1000);

  // --- 2. The REAL Classic Wholesale file, first 900 rows (covers
  // several real batch boundaries at 500-row size, includes real
  // unrecognized-brand rows, real auto-creates, and whatever genuine
  // in-file repeats exist in this real supplier's actual sheet). ---
  const filePath = process.argv[2] ?? "/tmp/classic-wholesale-export.xlsx";
  if (fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    const rawRows = parseSpreadsheetRaw(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const headerRes = resolveHeaderRow(rawRows, undefined, undefined);
    const headerRow = rawRows[headerRes.headerRowIndex];
    const headerSig = computeHeaderSignature(headerRow);
    const columnMap = suggestColumnMapping(headerRow);
    const dataRows = rawRows.slice(headerRes.headerRowIndex + 1);
    const allRealRows = applyColumnMapping(dataRows, columnMap, headerSig);
    const realRowsSubset = allRealRows.slice(0, 900);
    await check("real Classic Wholesale file, first 900 rows, batch=500", realRowsSubset, 500);
    await check("real Classic Wholesale file, first 900 rows, batch=137 (irregular boundary)", realRowsSubset, 137);
  } else {
    console.log(`(skipping real-file check — ${filePath} not found)`);
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}
main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
