// Phase 2 benchmark: measure the CURRENT searchReferenceProducts
// implementation's real latency against the production catalog before
// building the token-index replacement. Read-only.
import { searchReferenceProducts, getAllReferenceProducts } from "../src/lib/pricing-db";

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const result = await fn();
  console.log(`${label}: ${Date.now() - start}ms`);
  return result;
}

async function main() {
  const all = await time("getAllReferenceProducts (full catalog, MGET-paginated)", () => getAllReferenceProducts());
  console.log(`Catalog size: ${all.length}`);

  const sample = all[Math.floor(all.length / 2)];
  const exactQuery = `${sample.brand} ${sample.name}`;
  console.log(`\nSample mid-catalog record: "${exactQuery}" (${sample.sizeMl}ml)`);

  const exactResults = await time(`searchReferenceProducts("${exactQuery}") [exact, mid-catalog]`, () => searchReferenceProducts(exactQuery, 20));
  console.log(`  found ${exactResults.length} results`);

  const words = exactQuery.split(" ");
  const reordered = [...words].reverse().join(" ");
  const reorderedResults = await time(`searchReferenceProducts("${reordered}") [reordered]`, () => searchReferenceProducts(reordered, 20));
  console.log(`  reordered query found ${reorderedResults.length} results (substring match should fail this -> 0 expected today)`);

  await time(`searchReferenceProducts("ml") [common short term, likely worst-case scan]`, () => searchReferenceProducts("ml", 20));

  await time(`searchReferenceProducts("zzzznomatchxyz123") [no match, full scan to exhaustion]`, () => searchReferenceProducts("zzzznomatchxyz123", 20));

  const last = all[all.length - 1];
  const lastQuery = `${last.brand} ${last.name}`;
  const lastResults = await time(`searchReferenceProducts("${lastQuery}") [last record in index]`, () => searchReferenceProducts(lastQuery, 20));
  console.log(`  found ${lastResults.length} results (must be findable -- "old record equally findable" guarantee)`);
}
main();
