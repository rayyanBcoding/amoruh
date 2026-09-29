// READ-ONLY. Diagnostic script for the Classic Wholesale parse-preview
// timeout investigation — measures real, current-catalog cost of the
// pool-construction and per-row matching steps that computeMatchPreview
// runs, so batch sizing for the resumable-preview fix is based on real
// numbers rather than the (now-stale, pre-catalog-growth) figures in
// pricing-process.ts's own comments.
import { getProducts } from "../src/lib/db";
import { getAllReferenceProducts } from "../src/lib/pricing-db";
import { buildMasterCandidatePool, buildBrandBucketedPool, matchSupplierRow } from "../src/lib/pricing-matching";

async function main() {
  const t0 = Date.now();
  const [products, referenceProducts] = await Promise.all([getProducts(), getAllReferenceProducts()]);
  const t1 = Date.now();
  console.log(`getProducts + getAllReferenceProducts: ${t1 - t0}ms (${products.length} products, ${referenceProducts.length} reference products)`);

  const pool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));
  const t2 = Date.now();
  console.log(`buildBrandBucketedPool(buildMasterCandidatePool(...)): ${t2 - t1}ms`);

  const brands = ["Creed", "Tom Ford", "Chanel", "Dior", "Versace", "Xerjoff", "Amouage", "Parfums de Marly"];
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    offerKey: `synthetic:${i}`,
    supplierSku: `SKU-${i}`,
    description: `${brands[i % brands.length]} Synthetic Fragrance Number ${i} (U) EDP 100ML`,
    brand: brands[i % brands.length],
    upc: "",
    ean: "",
  }));

  const t3 = Date.now();
  for (const row of rows) {
    matchSupplierRow(row, products, [], referenceProducts, pool);
  }
  const t4 = Date.now();
  const perRow = (t4 - t3) / rows.length;
  console.log(`matchSupplierRow over ${rows.length} synthetic worst-case (brand-known, no-barcode, no-match) rows: ${t4 - t3}ms total, ${perRow.toFixed(2)}ms/row`);
  console.log(`Extrapolated for 6,500 rows at this rate: ${((perRow * 6500) / 1000).toFixed(1)}s matching alone`);
  console.log(`Extrapolated for 1,000-row batch at this rate: ${((perRow * 1000) / 1000).toFixed(1)}s`);
}
main();

async function measureUnrecognizedBrandWorstCase() {
  const [products, referenceProducts] = await Promise.all([getProducts(), getAllReferenceProducts()]);
  const pool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));

  // Worst case: brand text that extractAttributes/resolveEffectiveBrand
  // won't recognize as any known brand token -- forces narrowPoolForRow's
  // `bucketed.all` fallback (the full ~15,000-record pool) on every row,
  // instead of a small per-brand bucket.
  const rows = Array.from({ length: 500 }, (_, i) => ({
    offerKey: `synthetic-unknown:${i}`,
    supplierSku: `CW-${i}`,
    description: `ZzqwFragranceHouse Unknown Item Number ${i} 100ML SPRAY`,
    brand: "ZzqwFragranceHouse",
    upc: "",
    ean: "",
  }));

  const t0 = Date.now();
  for (const row of rows) {
    matchSupplierRow(row, products, [], referenceProducts, pool);
  }
  const t1 = Date.now();
  const perRow = (t1 - t0) / rows.length;
  console.log(`\n--- Unrecognized-brand worst case (full-pool fallback) ---`);
  console.log(`matchSupplierRow over ${rows.length} unrecognized-brand rows: ${t1 - t0}ms total, ${perRow.toFixed(2)}ms/row`);
  console.log(`Extrapolated for 6,500 rows at this rate: ${((perRow * 6500) / 1000).toFixed(1)}s matching alone`);
  console.log(`Extrapolated for 1,000-row batch at this rate: ${((perRow * 1000) / 1000).toFixed(1)}s`);
}
measureUnrecognizedBrandWorstCase();
