// READ-ONLY isolated test. Proves stepMatchPreviewBatch, run in several
// small chunks with state carried forward, produces BYTE-IDENTICAL
// aggregate counts to the original single-pass computeMatchPreview over
// the same rows — the whole point of the parse-preview resumable-batch
// fix is that splitting the work across requests must never change what
// preview reports. Uses the real production catalog (read-only) plus
// synthetic rows constructed to specifically exercise the cross-batch
// "would-create" dedup path (the same physical new item appearing twice,
// split across two different batches).
import assert from "assert";
import { getProducts } from "../src/lib/db";
import { getAllReferenceProducts } from "../src/lib/pricing-db";
import { computeMatchPreview, createEmptyMatchPreviewBatchState, stepMatchPreviewBatch } from "../src/lib/pricing-matching";

interface Row { supplierSku: string; description: string; brand: string; upc: string; ean: string }

function runInBatches(rows: Row[], products: Awaited<ReturnType<typeof getProducts>>, referenceProducts: Awaited<ReturnType<typeof getAllReferenceProducts>>, batchSize: number) {
  const state = createEmptyMatchPreviewBatchState();
  for (let i = 0; i < rows.length; i += batchSize) {
    stepMatchPreviewBatch(rows.slice(i, i + batchSize), products, [], referenceProducts, state);
  }
  return {
    totalRows: rows.length,
    matchedProduct: state.matchedProduct,
    matchedReferenceProduct: state.matchedReferenceProduct,
    proposedNewMasterProducts: state.proposedNewMasterProducts,
    requiresReview: state.requiresReview,
    nonProductRows: state.nonProductRows,
  };
}

async function main() {
  const [products, referenceProducts] = await Promise.all([getProducts(), getAllReferenceProducts()]);
  let passed = 0;
  let failed = 0;

  function check(name: string, rows: Row[], batchSize: number) {
    const single = computeMatchPreview(rows, products, [], referenceProducts);
    const batched = runInBatches(rows, products, referenceProducts, batchSize);
    try {
      assert.deepStrictEqual(batched, single, `${name}: batched output did not match single-pass output`);
      console.log(`PASS: ${name} (batchSize=${batchSize}, rows=${rows.length}) -> ${JSON.stringify(single)}`);
      passed++;
    } catch {
      console.log(`FAIL: ${name}`);
      console.log(`  single:  ${JSON.stringify(single)}`);
      console.log(`  batched: ${JSON.stringify(batched)}`);
      failed++;
    }
  }

  // 1. Known real brands, clean matches -- exercises the normal path.
  const brands = ["Creed", "Tom Ford", "Chanel", "Dior", "Versace"];
  const cleanRows: Row[] = Array.from({ length: 47 }, (_, i) => ({
    supplierSku: `SKU-${i}`,
    description: `${brands[i % brands.length]} Synthetic Fragrance Number ${i} (U) EDP 100ML`,
    brand: brands[i % brands.length],
    upc: "",
    ean: "",
  }));
  check("clean known-brand rows, small batches", cleanRows, 10);
  check("clean known-brand rows, batch=1 (every row its own batch)", cleanRows, 1);
  check("clean known-brand rows, batch=1000 (single batch, sanity)", cleanRows, 1000);

  // 2. Genuinely new items, WITH intra-file repeats split across batch
  // boundaries -- the exact case the cross-batch dedup exists for. Each
  // "NewHouse Alpha"/"NewHouse Beta" item appears 3 times; without state
  // carried correctly across batches, proposedNewMasterProducts would
  // overcount.
  const repeatingNewRows: Row[] = [];
  for (let i = 0; i < 9; i++) {
    const which = i % 3 === 0 ? "Alpha" : i % 3 === 1 ? "Beta" : "Gamma";
    repeatingNewRows.push({
      supplierSku: `NEW-${i}`,
      description: `Brandnewhouse ${which} Fragrance (U) EDP 100ML`,
      brand: "Brandnewhouse",
      upc: "",
      ean: "",
    });
  }
  check("repeating new items split across small batches", repeatingNewRows, 2);
  check("repeating new items split across batch=1", repeatingNewRows, 1);

  // 3. Mixed: non-product rows, ambiguous/incomplete rows, and unknown-
  // brand rows (forces the full-pool fallback path) all in one file,
  // batch boundaries falling mid-run of each category.
  const mixedRows: Row[] = [
    { supplierSku: "", description: "TOTAL", brand: "", upc: "", ean: "" }, // non-product
    { supplierSku: "M1", description: "Dior Sauvage 100ML", brand: "Dior", upc: "", ean: "" }, // ambiguous concentration
    { supplierSku: "M2", description: "ZzqwFragranceHouse Unknown Item 100ML SPRAY", brand: "ZzqwFragranceHouse", upc: "", ean: "" },
    { supplierSku: "", description: "SHIPPING", brand: "", upc: "", ean: "" },
    { supplierSku: "M3", description: "Chanel No 5 EDP 100ML", brand: "Chanel", upc: "", ean: "" },
  ];
  check("mixed categories, batch=2", mixedRows, 2);
  check("mixed categories, batch=3", mixedRows, 3);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}
main();
