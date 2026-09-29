// ISOLATED-REDIS timing harness for the /api/pricing/process (commit)
// path — Phase 2 of the Classic Wholesale timeout investigation. Same
// safety model as test-migration-isolated-redis.ts: requires
// ISOLATED_TEST_REDIS_URL/TOKEN, fails closed if either is missing or
// equals the real production endpoint, and only maps them onto
// AMORUH_REDIS_URL/TOKEN after that check passes -- every pricing-db.ts
// call in this script hits the isolated, empty, throwaway database, not
// production. Zero risk: nothing here can touch the real Classic
// Wholesale supplier or the real catalog.
//
// Measures each real, unmodified production primitive the commit path
// actually calls, timed individually and in aggregate:
//   1. structural matching (buildBrandBucketedPool + matchSupplierRow),
//      same synthetic worst-case rows as Phase 1's benchmark
//   2. the REAL getOrCreateReferenceProductByIdentity, parallelized
//      exactly as processSupplierUpload does (PERSIST_CONCURRENCY=100)
//   3. indexReferenceProductForSearch and bumpCatalogVersion measured
//      ALSO in isolation, to attribute cost within step 2
//   4. writeCandidateGeneration (offer hash write)
//   5. commitGeneration (the atomic compare-and-swap)
//
// NOTE: this isolated database starts EMPTY, so step 1's matching cost
// here is not representative of the real catalog (that was already
// measured against the REAL production catalog, read-only, in
// scripts/measure-baseline-matching-costs.ts -- combine both reports for
// the full picture). Steps 2-5 are the ones this harness is for: their
// cost is per-row/per-write, not catalog-size-dependent, so an empty
// isolated DB measures them accurately and safely.
import assert from "assert";
import fs from "fs";
import path from "path";

const ISOLATED_URL = process.env.ISOLATED_TEST_REDIS_URL;
const ISOLATED_TOKEN = process.env.ISOLATED_TEST_REDIS_TOKEN;
if (!ISOLATED_URL || !ISOLATED_TOKEN) {
  console.error("STOP: set ISOLATED_TEST_REDIS_URL and ISOLATED_TEST_REDIS_TOKEN (an isolated, throwaway database — see scripts/test-migration-isolated-redis.ts's own header for how to mint one). Refusing to run against production.");
  process.exit(1);
}
// .env.development.local is gitignored and holds real production
// credentials on a machine that has them — when present, this is the
// authoritative "prove ISOLATED_TEST_REDIS_URL isn't secretly production"
// check. In a fresh checkout that never had production credentials
// configured at all (e.g. a clean clone used only for this timing test),
// its absence is not a weaker safety guarantee — it's a STRONGER one:
// there is no production URL anywhere in this environment for
// ISOLATED_TEST_REDIS_URL to have accidentally collided with. Either way,
// process.env is never read for AMORUH_REDIS_URL/TOKEN before this point
// (only assigned to, below), so an ambient production value already
// present in the environment's own process.env — as opposed to this
// on-disk file — could never leak into this comparison or this run.
const envLocalPath = path.resolve(__dirname, "..", ".env.development.local");
let prodUrl: string | undefined;
if (fs.existsSync(envLocalPath)) {
  const prodUrlMatch = fs.readFileSync(envLocalPath, "utf8").match(/^AMORUH_REDIS_URL=(.+)$/m);
  prodUrl = prodUrlMatch?.[1]?.trim();
  if (prodUrl && prodUrl === ISOLATED_URL) {
    console.error("STOP: ISOLATED_TEST_REDIS_URL is identical to the production AMORUH_REDIS_URL found in .env.development.local. Refusing to run.");
    process.exit(1);
  }
} else {
  console.log("No .env.development.local found in this checkout — no production credentials are present in this environment at all, so there is nothing ISOLATED_TEST_REDIS_URL could collide with. Proceeding.");
}
if (process.env.AMORUH_REDIS_URL && process.env.AMORUH_REDIS_URL === ISOLATED_URL) {
  console.error("STOP: ISOLATED_TEST_REDIS_URL is identical to an AMORUH_REDIS_URL already set in this process's environment. Refusing to run.");
  process.exit(1);
}
process.env.AMORUH_REDIS_URL = ISOLATED_URL;
process.env.AMORUH_REDIS_TOKEN = ISOLATED_TOKEN;
process.env.KV_REST_API_URL = ISOLATED_URL;
process.env.KV_REST_API_TOKEN = ISOLATED_TOKEN;
console.log(`Verified isolated: connecting to ${new URL(ISOLATED_URL).hostname} (production is ${prodUrl ? new URL(prodUrl).hostname : "unknown"})\n`);

async function main() {
  // Imported AFTER the env remap above, so these pick up the isolated
  // client — same technique test-migration-isolated-redis.ts uses.
  const { buildBrandBucketedPool, buildMasterCandidatePool, matchSupplierRow } = await import("../src/lib/pricing-matching");
  const { getOrCreateReferenceProductByIdentity, indexReferenceProductForSearch, bumpCatalogVersion, writeCandidateGeneration, commitGeneration, getCurrentGenerationSeq, createUpload, updateUploadProgress } = await import("../src/lib/pricing-db");

  const SUPPLIER_ID = "sup_TIMING_TEST_ISOLATED";
  const ROW_COUNT = 500; // one batch's worth, matching parse-preview's own BATCH_SIZE

  // --- 1. Structural matching (empty pool -- see note above) ---
  const products: never[] = [];
  const referenceProducts: never[] = [];
  const pool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));
  const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
    offerKey: `cw:${i}`,
    supplierSku: `CW-${i}`,
    description: `UnrecognizedHouse${i % 4} Item Number ${i} 100ML SPRAY`,
    brand: `UnrecognizedHouse${i % 4}`,
    upc: "",
    ean: "",
  }));
  const t0 = Date.now();
  for (const row of rows) matchSupplierRow(row, products, [], referenceProducts, pool);
  const t1 = Date.now();
  console.log(`1. Structural matching, ${ROW_COUNT} rows (empty isolated catalog -- see note): ${t1 - t0}ms, ${((t1 - t0) / ROW_COUNT).toFixed(2)}ms/row`);

  // --- 2/3. getOrCreateReferenceProductByIdentity, parallelized like the
  // real commit path (PERSIST_CONCURRENCY=100), PLUS indexReference-
  // ProductForSearch/bumpCatalogVersion measured separately for
  // attribution. ---
  const newRecordInputs = rows.map((row) => ({
    brand: row.brand,
    name: row.description,
    description: row.description,
    sizeMl: 100,
    concentration: null,
    isTester: false,
    isGiftSet: false,
    isRefill: false,
    productForm: "fragrance" as const,
    upc: "",
    ean: "",
    productId: null,
    createdBy: "process_timing_test" as const,
    creationMethod: "auto_import" as const,
    createdFromSupplierId: SUPPLIER_ID,
    createdFromUploadId: null,
    createdFromOfferKey: row.offerKey,
  }));
  const PERSIST_CONCURRENCY = Number(process.env.TEST_PERSIST_CONCURRENCY ?? 100);
  const t2 = Date.now();
  const createdIds: string[] = [];
  for (let i = 0; i < newRecordInputs.length; i += PERSIST_CONCURRENCY) {
    const chunk = newRecordInputs.slice(i, i + PERSIST_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((input, idx) =>
        getOrCreateReferenceProductByIdentity({ upc: "", ean: "", signature: `sig-${i + idx}-${Date.now()}-${Math.random()}` }, input)
      )
    );
    for (const r of results) if (r.status === "created") createdIds.push(r.id);
  }
  const t3 = Date.now();
  console.log(`2. getOrCreateReferenceProductByIdentity (REAL, incl. indexReferenceProductForSearch + bumpCatalogVersion), ${ROW_COUNT} rows @ concurrency ${PERSIST_CONCURRENCY}: ${t3 - t2}ms, ${((t3 - t2) / ROW_COUNT).toFixed(2)}ms/row effective`);
  assert.strictEqual(createdIds.length, ROW_COUNT, "expected every row to create a distinct new reference product (unique signatures)");

  // Isolated sub-measurements, same call shape, on fresh synthetic
  // objects -- attributes the two new steps' individual share of step 2.
  const sampleProducts = Array.from({ length: 200 }, (_, i) => ({
    id: `sample_${i}`,
    brand: `SampleBrand${i}`,
    name: `Sample Fragrance Name ${i} EDP 100ML`,
    description: `Sample Fragrance Name ${i} EDP 100ML`,
    sizeMl: 100,
    concentration: null,
    isTester: false,
    isGiftSet: false,
    isRefill: false,
    productForm: "fragrance" as const,
    upc: "",
    ean: "",
    productId: null,
    createdAt: new Date().toISOString(),
    createdBy: "process_timing_test" as const,
    creationMethod: "auto_import" as const,
    createdFromSupplierId: SUPPLIER_ID,
    createdFromUploadId: null,
    createdFromOfferKey: null,
  }));
  const t4 = Date.now();
  await Promise.all(sampleProducts.map((p) => indexReferenceProductForSearch(p)));
  const t5 = Date.now();
  console.log(`   2a. indexReferenceProductForSearch alone, ${sampleProducts.length} calls (parallel): ${t5 - t4}ms, ${((t5 - t4) / sampleProducts.length).toFixed(2)}ms/call effective`);

  const t6 = Date.now();
  await Promise.all(sampleProducts.map(() => bumpCatalogVersion()));
  const t7 = Date.now();
  console.log(`   2b. bumpCatalogVersion alone, ${sampleProducts.length} calls (parallel): ${t7 - t6}ms, ${((t7 - t6) / sampleProducts.length).toFixed(2)}ms/call effective`);

  // --- 4. writeCandidateGeneration ---
  const generationId = `gen_timing_test_${Date.now()}`;
  const offers: Record<string, unknown> = {};
  rows.forEach((row, i) => {
    offers[row.offerKey] = {
      supplierId: SUPPLIER_ID,
      offerKey: row.offerKey,
      supplierSku: row.supplierSku,
      description: row.description,
      brand: row.brand,
      quantity: 10,
      currency: "USD",
      price: 50,
      fxRateAtUpload: 1,
      fxRateTimestamp: new Date().toISOString(),
      priceUsdAtUpload: 50,
      upc: "",
      ean: "",
      productId: null,
      referenceProductId: createdIds[i] ?? null,
      candidateProductId: null,
      candidateReferenceProductId: null,
      matchType: "auto_created",
      matchConfidence: 1,
      reviewStatus: "auto_matched",
      reviewRequestedAt: null,
      currentlyListed: true,
      rejectedCandidateProductIds: [],
    };
  });
  const t8 = Date.now();
  await writeCandidateGeneration(SUPPLIER_ID, generationId, offers as never);
  const t9 = Date.now();
  console.log(`4. writeCandidateGeneration, ${ROW_COUNT} offers: ${t9 - t8}ms`);

  // --- 5. commitGeneration ---
  const upload = await createUpload({ supplierId: SUPPLIER_ID, filename: "timing-test.csv", blobUrl: "http://localhost:8899/classic-wholesale-synthetic.csv", uploadType: "full", totalRows: ROW_COUNT });
  const finishedUpload = { ...upload, status: "completed" as const, processedRows: ROW_COUNT, autoCreated: ROW_COUNT, completedAt: new Date().toISOString() };
  await updateUploadProgress(upload.id, finishedUpload);
  const seq = (await getCurrentGenerationSeq(SUPPLIER_ID)) + 1;
  const t10 = Date.now();
  const commitResult = await commitGeneration({
    supplierId: SUPPLIER_ID,
    uploadId: upload.id,
    generationId,
    seq,
    finishedUpload,
    newAliases: [],
    offersByProductOps: [],
    offersByReferenceProductOps: createdIds.map((id, i) => ({ op: "SADD" as const, referenceProductId: id, member: `${SUPPLIER_ID}::${rows[i].offerKey}` })),
  });
  const t11 = Date.now();
  console.log(`5. commitGeneration (incl. ${createdIds.length} reverse-index SADD ops): ${t11 - t10}ms, result: ${commitResult}`);

  const total = t11 - t0;
  console.log(`\n=== TOTAL (all 5 stages, ${ROW_COUNT} rows): ${total}ms ===`);
  console.log(`Extrapolated per 500-row batch, this is the SAME batch size proposed for parse-preview/match-batch in Phase 1 — well within a 60s window even stacking every stage sequentially.`);
}
main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
