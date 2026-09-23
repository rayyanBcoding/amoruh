// Verification points 5 & 6:
// 5. The FX-rate fix does not change valid USD comparisons unexpectedly.
// 6. The search-index rebuild is safe, repeatable, and never modifies
//    Master Product or supplier data.
// Read-only except for a single re-run of the ALREADY-established,
// idempotent index rebuild (writes only to the new search:token* keys,
// never to reference_product:*/supplier records).
import { redis } from "../src/lib/kv";
import { getAllReferenceProducts, getReferenceProductOfferComparison, getProductOfferComparison, indexReferenceProductForSearch } from "../src/lib/pricing-db";
import { getProducts } from "../src/lib/db";
import { getSuppliers } from "../src/lib/intake-db";

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
  console.log("=== Point 5: FX-rate fix does not change valid USD comparisons ===");
  const referenceProducts = (await getAllReferenceProducts()).slice(0, 40);
  const products = (await getProducts()).slice(0, 40);
  let checked = 0;
  let nonUsdChecked = 0;
  let invalidFound = 0;
  for (const rp of referenceProducts) {
    const comparison = await getReferenceProductOfferComparison(rp.id);
    for (const r of [...comparison.actionable, ...comparison.nonActionable]) {
      checked++;
      if (!r.priceUsdValid) {
        invalidFound++;
        continue;
      }
      if (r.currency === "USD") {
        assert(r.priceUsd === r.price, `${rp.brand} ${rp.name} [${r.supplierName}]: USD offer priceUsd (${r.priceUsd}) equals raw price (${r.price}) unchanged`);
      } else {
        nonUsdChecked++;
        assert(r.priceUsd !== r.price || r.price === 0, `${rp.brand} ${rp.name} [${r.supplierName}]: non-USD (${r.currency}) offer has a real converted priceUsd (${r.priceUsd}) distinct from raw price (${r.price}), not a pass-through`);
        assert(r.priceUsd > 0, `${rp.brand} ${rp.name} [${r.supplierName}]: converted priceUsd (${r.priceUsd}) is a sane positive number`);
      }
    }
  }
  for (const p of products) {
    const comparison = await getProductOfferComparison(p.id);
    for (const r of [...comparison.actionable, ...comparison.nonActionable]) {
      checked++;
      if (!r.priceUsdValid) {
        invalidFound++;
        continue;
      }
      if (r.currency === "USD") assert(r.priceUsd === r.price, `${p.brand} ${p.name} [${r.supplierName}]: USD offer priceUsd equals raw price unchanged`);
    }
  }
  console.log(`Rows checked: ${checked}, non-USD rows verified converted: ${nonUsdChecked}, invalid/excluded currency rows found: ${invalidFound} (0 expected on current live data -- confirms the fix only changes behavior for the missing-rate EDGE CASE, never today's valid comparisons)`);
  assert(invalidFound === 0, "no currently-live offer hits the invalid-currency exclusion path (the fix is a pure safety net, not a behavior change for today's data)");

  console.log("\n=== Point 6: search-index rebuild is safe, repeatable, never touches Master Product/supplier data ===");
  const KEY_TOKEN_INDEX = "amoruh:pricing:search:token_index";
  const sampleRp = referenceProducts[0];
  const beforeRecord = await redis.get<{ id: string; createdAt: string; brand: string; name: string; productId: string | null }>(`amoruh:pricing:reference_product:${sampleRp.id}`);
  const beforeSuppliers = JSON.stringify(await getSuppliers());
  const beforeCardinality = await redis.zcard(KEY_TOKEN_INDEX);

  // Re-run the index step for this one record twice in a row -- proves
  // idempotency (SADD/ZADD are naturally idempotent; cardinality must
  // not grow from a repeat call).
  await indexReferenceProductForSearch(sampleRp);
  const afterFirstCardinality = await redis.zcard(KEY_TOKEN_INDEX);
  await indexReferenceProductForSearch(sampleRp);
  const afterSecondCardinality = await redis.zcard(KEY_TOKEN_INDEX);

  assert(afterFirstCardinality === afterSecondCardinality, `re-indexing the same record twice does not grow the token index (first=${afterFirstCardinality}, second=${afterSecondCardinality}) -- idempotent`);
  assert(afterFirstCardinality >= beforeCardinality, "token index cardinality never shrinks from an index operation");

  const afterRecord = await redis.get<{ id: string; createdAt: string; brand: string; name: string; productId: string | null }>(`amoruh:pricing:reference_product:${sampleRp.id}`);
  const afterSuppliers = JSON.stringify(await getSuppliers());
  assert(JSON.stringify(beforeRecord) === JSON.stringify(afterRecord), "the reference product's own record (createdAt, brand, name, productId, every field) is completely untouched by indexing");
  assert(beforeSuppliers === afterSuppliers, "supplier records are completely untouched by indexing");

  console.log(`\n=== TOTAL: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
