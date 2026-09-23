// Rebuilds the reference-product search token index from scratch,
// straight from getAllReferenceProducts() -- the safety net if
// incremental maintenance (indexReferenceProductForSearch, called at
// creation time) ever drifts, and the tool used to build the index the
// first time. Safe to re-run any number of times (SADD/ZADD are
// idempotent) -- does not delete anything for products that still
// exist; only ever adds/refreshes memberships.
import { getAllReferenceProducts, indexReferenceProductForSearch } from "../src/lib/pricing-db";

async function main() {
  const products = await getAllReferenceProducts();
  console.log(`Rebuilding search index for ${products.length} reference products...`);
  let done = 0;
  const BATCH = 50;
  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    await Promise.all(batch.map((p) => indexReferenceProductForSearch(p)));
    done += batch.length;
    if (done % 1000 < BATCH) console.log(`  ...${done}/${products.length}`);
  }
  console.log(`Done. Indexed ${done} reference products.`);
}
main();
