// Phase 1 regression test: isActionableOffer (extracted from
// splitAndRankComparisonRows) must behave identically to the old inline
// predicate on real data, except for the new priceUsdValid check, which
// must exclude a missing/failed FX conversion instead of silently
// treating a raw non-USD price as USD. Read-only against production.
import { getAllReferenceProducts, getReferenceProductOfferComparison, isActionableOffer } from "../src/lib/pricing-db";
import { getProducts } from "../src/lib/db";
import { getProductOfferComparison } from "../src/lib/pricing-db";
import type { OfferComparisonRow } from "../src/lib/pricing-types";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`);
  }
}

// The OLD predicate, byte-for-byte, minus the priceUsdValid check --
// used here to prove the new function agrees with it on every row
// where priceUsdValid is true (which today's live data always is, per
// the live check below).
function oldPredicate(r: OfferComparisonRow): boolean {
  return r.currentlyListed && (r.quantity === null || r.quantity > 0) && !r.isStale && (r.reviewStatus === "auto_matched" || r.reviewStatus === "confirmed");
}

function baseRow(overrides: Partial<OfferComparisonRow>): OfferComparisonRow {
  return {
    supplierId: "s1",
    supplierName: "Test Supplier",
    offerKey: "k1",
    price: 100,
    currency: "USD",
    priceUsd: 100,
    priceUsdValid: true,
    currentlyListed: true,
    quantity: 5,
    isStale: false,
    ageDays: 1,
    uploadedAt: new Date().toISOString(),
    reviewStatus: "auto_matched",
    differenceFromBestUsd: null,
    ...overrides,
  };
}

async function main() {
  console.log("=== Unit tests: isActionableOffer ===");
  assert(isActionableOffer(baseRow({})) === true, "normal actionable row -> true");
  assert(isActionableOffer(baseRow({ currentlyListed: false })) === false, "delisted -> false");
  assert(isActionableOffer(baseRow({ quantity: 0 })) === false, "out of stock -> false");
  assert(isActionableOffer(baseRow({ quantity: null })) === true, "null quantity (unspecified, treated as available) -> true");
  assert(isActionableOffer(baseRow({ isStale: true })) === false, "stale -> false");
  assert(isActionableOffer(baseRow({ reviewStatus: "needs_review" })) === false, "needs_review -> false");
  assert(isActionableOffer(baseRow({ reviewStatus: "confirmed" })) === true, "confirmed -> true");
  assert(isActionableOffer(baseRow({ priceUsdValid: false })) === false, "NEW: missing/failed FX conversion -> false (previously would have silently passed as raw-price-as-USD)");
  assert(isActionableOffer(baseRow({ priceUsdValid: false, currentlyListed: true, quantity: 5, isStale: false, reviewStatus: "auto_matched" })) === false, "NEW: otherwise-perfect row still excluded solely for invalid currency conversion");

  console.log(`\nUnit tests: ${pass} passed, ${fail} failed so far.`);

  console.log("\n=== Live agreement check against production (read-only) ===");
  const [referenceProducts, products] = await Promise.all([getAllReferenceProducts(), getProducts()]);
  let rowsChecked = 0;
  let invalidCurrencyRowsFound = 0;

  // Sample a bounded number of reference products and real products that
  // actually have offers, to keep this fast.
  const refSample = referenceProducts.slice(0, 25);
  for (const rp of refSample) {
    const comparison = await getReferenceProductOfferComparison(rp.id);
    for (const r of [...comparison.actionable, ...comparison.nonActionable]) {
      rowsChecked++;
      if (!r.priceUsdValid) invalidCurrencyRowsFound++;
      // Agreement check: for any row where priceUsdValid is true, the
      // new predicate must agree exactly with the old one.
      if (r.priceUsdValid) {
        const isInActionable = comparison.actionable.some((a) => a.offerKey === r.offerKey && a.supplierId === r.supplierId);
        assert(oldPredicate(r) === isInActionable, `reference product ${rp.id} offer ${r.offerKey}: old predicate agrees with actual actionable placement`);
      }
    }
  }

  const productSample = products.slice(0, 100);
  for (const p of productSample) {
    const comparison = await getProductOfferComparison(p.id);
    for (const r of [...comparison.actionable, ...comparison.nonActionable]) {
      rowsChecked++;
      if (!r.priceUsdValid) invalidCurrencyRowsFound++;
      if (r.priceUsdValid) {
        const isInActionable = comparison.actionable.some((a) => a.offerKey === r.offerKey && a.supplierId === r.supplierId);
        assert(oldPredicate(r) === isInActionable, `product ${p.id} offer ${r.offerKey}: old predicate agrees with actual actionable placement`);
      }
    }
  }

  console.log(`Rows checked across ${refSample.length} reference products + ${productSample.length} real products: ${rowsChecked}`);
  console.log(`Rows with an invalid/missing currency conversion found: ${invalidCurrencyRowsFound} (0 expected today -- all live currencies already have cached FX rates; this is the edge case the fix now correctly excludes IF it ever occurs)`);

  console.log(`\n=== TOTAL: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
