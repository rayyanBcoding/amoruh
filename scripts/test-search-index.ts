// Explicit test for the search index's required behaviors: prefix
// matching while typing, exact-match prioritization, and unrelated-brand
// exclusion. Read-only against production (the index itself was already
// built by rebuild-search-index.ts).
import { searchReferenceProducts, getAllReferenceProducts } from "../src/lib/pricing-db";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`);
  }
}

async function main() {
  const all = await getAllReferenceProducts();
  const burberry = all.filter((p) => p.brand.toUpperCase().includes("BURBERRY"));
  console.log(`Burberry records in catalog: ${burberry.length}`);

  if (burberry.length > 0) {
    const prefixResults = await searchReferenceProducts("burber", 20);
    assert(
      prefixResults.some((r) => r.brand.toUpperCase().includes("BURBERRY")),
      `partial/prefix word "burber" finds at least one Burberry product (found ${prefixResults.length} total results)`
    );
    console.log(
      `"burber" -> top results: ${prefixResults
        .slice(0, 5)
        .map((r) => `${r.brand} ${r.name}`)
        .join(" | ")}`
    );
  } else {
    console.log("No Burberry records in this catalog -- skipping brand-specific prefix assertion, trying a generic prefix instead.");
  }

  // Generic prefix test: take a real brand's first 5 characters (a whole
  // word prefix) and confirm the full brand is findable.
  const sample = all[100];
  const brandPrefix = sample.brand.slice(0, Math.min(5, sample.brand.length)).toLowerCase();
  if (brandPrefix.length >= 3) {
    const results = await searchReferenceProducts(brandPrefix, 30);
    assert(
      results.some((r) => r.brand.toLowerCase().startsWith(brandPrefix)),
      `prefix "${brandPrefix}" (from real brand "${sample.brand}") finds a matching product`
    );
  }

  // Exact-match prioritization: an exact full-name query's own record
  // should rank #1 even when other records share some of its words.
  const exactQuery = `${sample.brand} ${sample.name}`;
  const exactResults = await searchReferenceProducts(exactQuery, 20);
  assert(exactResults.length > 0 && exactResults[0].id === sample.id, `exact query "${exactQuery}" ranks its own record first`);

  // Unrelated-brand exclusion: a query for one specific brand+name should
  // not surface an unrelated brand in the top results.
  const otherBrandSample = all.find((p) => p.brand !== sample.brand);
  if (otherBrandSample) {
    const results = await searchReferenceProducts(`${sample.brand} ${sample.name}`, 5);
    const unrelatedInTop = results.filter((r) => r.brand !== sample.brand);
    assert(unrelatedInTop.length === 0, `query for "${sample.brand} ${sample.name}" does not surface unrelated brands in top 5 (found: ${unrelatedInTop.map((r) => r.brand).join(", ") || "none"})`);
  }

  console.log(`\n=== TOTAL: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
