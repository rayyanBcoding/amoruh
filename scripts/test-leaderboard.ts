// Validates the new bulk leaderboard aggregation two ways:
// 1. Performance: one full computation must take seconds, not minutes
//    (the whole point of the bulk single-pass design vs. a per-product
//    comparison-function call, which was confirmed live this session to
//    take 60+ seconds for a SINGLE product lookup at this catalog scale
//    when accidentally used in the search route).
// 2. Correctness: cross-validates a sample of the leaderboard's own
//    competitive-product entries against the EXISTING, already-trusted
//    getProductOfferComparison/getReferenceProductOfferComparison
//    functions -- if the bulk path and the per-product path disagree on
//    bestPrice/eligible-supplier-count for the same identity, that's a
//    real bug. Read-only.
import { getSupplierPriceLeaderboard, getProductOfferComparison, getReferenceProductOfferComparison } from "../src/lib/pricing-db";
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
  const knownSupplierIds = new Set((await getSuppliers()).map((s) => s.id));
  const start = Date.now();
  const board = await getSupplierPriceLeaderboard();
  const elapsed = Date.now() - start;
  console.log(`First computation (cold cache): ${elapsed}ms`);
  assert(elapsed < 30000, `full leaderboard computation completes in well under 30s (was ${elapsed}ms) -- not minutes, per-product`);

  const start2 = Date.now();
  const board2 = await getSupplierPriceLeaderboard();
  const elapsed2 = Date.now() - start2;
  console.log(`Second read (warm, fingerprint-verified cache hit): ${elapsed2}ms`);
  assert(elapsed2 < 3000, `cached read is fast (was ${elapsed2}ms)`);
  assert(board2.computedAt === board.computedAt, "cached read returns the SAME computedAt -- did not silently recompute");

  console.log(`\nSuppliers: ${board.suppliers.length}`);
  console.log(`Competitive products: ${board.totals.competitiveProductCount} (outright wins: ${board.totals.outrightWinProductCount}, tied: ${board.totals.tiedProductCount})`);
  console.log(`Single-supplier-only products: ${board.singleSupplierProducts.length}`);
  for (const s of board.suppliers) {
    console.log(
      `  ${s.supplierName}: competitive=${s.competitiveProductCount} wins=${s.outrightWins} ties=${s.ties} winRate=${s.winRate}% singleSupplierOnly=${s.singleSupplierOnlyCount} eligibleOffers=${s.currentEligibleOfferCount}`
    );
  }

  // Reconciliation invariant.
  assert(
    board.totals.competitiveProductCount === board.totals.outrightWinProductCount + board.totals.tiedProductCount,
    `leaderboardTotals reconciliation: competitiveProductCount (${board.totals.competitiveProductCount}) === outrightWinProductCount (${board.totals.outrightWinProductCount}) + tiedProductCount (${board.totals.tiedProductCount})`
  );
  // Every competitive product must have >=2 distinct eligible suppliers,
  // by construction -- spot check the whole set (cheap, in-memory).
  const under2 = board.competitiveProducts.filter((p) => p.eligibleSupplierCount < 2);
  assert(under2.length === 0, `every competitive product has >=2 eligible suppliers (found ${under2.length} with fewer)`);
  // No tie should ever carry a perUnitAdvantage (nothing to report).
  const tiesWithAdvantage = board.competitiveProducts.filter((p) => p.isTie && p.perUnitAdvantageUsd !== null);
  assert(tiesWithAdvantage.length === 0, `no tied product reports a per-unit advantage (found ${tiesWithAdvantage.length})`);

  // Cross-validate a sample against the existing, trusted per-product
  // comparison functions.
  const sample = board.competitiveProducts.slice(0, 15);
  console.log(`\nCross-validating ${sample.length} competitive products against getProductOfferComparison/getReferenceProductOfferComparison...`);
  for (const p of sample) {
    const comparison = p.isCarried ? await getProductOfferComparison(p.identityKey) : await getReferenceProductOfferComparison(p.identityKey);
    // comparison.actionable is OFFER ROWS (a supplier can have multiple)
    // and, unlike the leaderboard, doesn't cross-check that the offer's
    // stored supplierId still resolves to a real current supplier (see
    // computeSupplierPriceLeaderboardData's own doc comment) -- filter
    // both concerns out here for a clean apples-to-apples comparison.
    const knownRows = comparison.actionable.filter((r) => knownSupplierIds.has(r.supplierId));
    const trustedBest = knownRows.length > 0 ? Math.min(...knownRows.map((r) => r.priceUsd)) : null;
    const trustedDistinctSuppliers = new Set(knownRows.map((r) => r.supplierId)).size;
    assert(trustedBest !== null && Math.abs(trustedBest - p.bestPriceUsd) < 0.01, `${p.brand} ${p.name}: bestPriceUsd matches trusted comparison function (leaderboard=${p.bestPriceUsd}, trusted=${trustedBest})`);
    assert(trustedDistinctSuppliers === p.eligibleSupplierCount, `${p.brand} ${p.name}: eligibleSupplierCount matches trusted comparison function's distinct-supplier count (leaderboard=${p.eligibleSupplierCount}, trusted=${trustedDistinctSuppliers}, trusted raw offer rows=${comparison.actionable.length})`);
  }

  console.log(`\n=== TOTAL: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
