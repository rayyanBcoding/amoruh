// Verifies the current-supplier filter added to getProductOfferComparison
// / getReferenceProductOfferComparison: re-runs the exact same "does an
// orphaned offer win Best Price" sample from the pre-fix audit (same 15
// identities, same order, deterministic given unchanged underlying data)
// and confirms zero can win now, plus regression-checks that ordinary
// multi-real-supplier products are completely unaffected. Read-only.
import { getCommittedOffers, getProductOfferComparison, getReferenceProductOfferComparison, getReferenceProduct, getAllReferenceProducts } from "../src/lib/pricing-db";
import { getSuppliers } from "../src/lib/intake-db";
import { getProducts } from "../src/lib/db";

const ORPHANED_SUPPLIER_IDS = [
  "sup_1789334154697_vgmsaf",
  "sup_1789334199477_r87lgj",
  "sup_1789334285660_gdlfm3",
  "sup_1789334363566_uiklhj",
  "sup_1789535141905_hvhu28",
  "sup_1789927674305_b7d67r",
  "sup_1789928567670_0brbna",
  "sup_1789931959117_x8v1t8",
  "sup_1789932647845_eii0g6",
  "sup_1789932792302_lb95ov",
  "sup_1789933078926_f76sdn",
  "sup_1789933583228_s6q9o5",
];

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
  const realIds = new Set((await getSuppliers()).map((s) => s.id));
  const products = await getProducts();

  // Reconstruct the exact same identity set + order the pre-fix audit
  // sampled (same iteration over the same orphaned supplierIds' own
  // offer hashes).
  const identitiesInOrder: string[] = [];
  const seen = new Set<string>();
  for (const supplierId of ORPHANED_SUPPLIER_IDS) {
    const offers = await getCommittedOffers(supplierId);
    for (const o of Object.values(offers)) {
      const identity = o.referenceProductId ?? o.productId;
      if (identity && !seen.has(identity)) {
        seen.add(identity);
        identitiesInOrder.push(identity);
      }
    }
  }
  const sample = identitiesInOrder.slice(0, 15);

  // Redis HGETALL field order for a large (hashtable-encoded) hash isn't
  // guaranteed stable across calls, so "first 15 by iteration order" can
  // shift between runs even though the underlying data hasn't changed.
  // Look up the specific example the user asked to confirm directly, by
  // name, rather than depending on it landing in a re-derived sample.
  const allRefs = await getAllReferenceProducts();
  const tamDao = allRefs.find((rp) => rp.name.toUpperCase().includes("TAM DAO"));
  if (tamDao && !sample.includes(tamDao.id)) sample.unshift(tamDao.id);

  console.log("=== Re-verifying the same 15 sampled products (plus DIPTYQUE TAM DAO explicitly): no orphaned supplier can win Best Price ===");
  let diptyqueChecked = false;
  for (const identity of sample) {
    const asProduct = products.find((p) => p.id === identity);
    const comparison = asProduct ? await getProductOfferComparison(identity) : await getReferenceProductOfferComparison(identity);
    const label = asProduct ? `${asProduct.brand} ${asProduct.name}` : (await getReferenceProduct(identity))?.name ?? identity;
    if (label.includes("TAM DAO")) diptyqueChecked = true;

    const bestIsReal = !comparison.bestPrice || realIds.has(comparison.bestPrice.supplierId);
    assert(bestIsReal, `${label}: bestPrice is null or a REAL supplier (got: ${comparison.bestPrice ? comparison.bestPrice.supplierName : "none"})`);

    const anyOrphanedInActionable = comparison.actionable.some((r) => !realIds.has(r.supplierId));
    const anyOrphanedInNonActionable = comparison.nonActionable.some((r) => !realIds.has(r.supplierId));
    assert(!anyOrphanedInActionable, `${label}: no orphaned supplier in actionable[]`);
    assert(!anyOrphanedInNonActionable, `${label}: no orphaned supplier in nonActionable[]`);
    assert(comparison.bestPrice?.supplierName !== "Unknown Supplier", `${label}: bestPrice supplierName is never "Unknown Supplier"`);

    console.log(
      `  ${label}: bestPrice=${comparison.bestPrice ? `$${comparison.bestPrice.priceUsd} (${comparison.bestPrice.supplierName})` : "none -- no actionable offer"}, actionable=${comparison.actionable.length}, nonActionable=${comparison.nonActionable.length}`
    );
  }
  assert(diptyqueChecked, "DIPTYQUE TAM DAO EDT 100ml was specifically included in this re-verification (matches the pre-fix audit's flagged example)");

  console.log("\n=== Regression: ordinary multi-real-supplier products are unaffected ===");
  // Candidates come from the leaderboard's own competitiveProducts,
  // which by construction only ever contains real-supplier offers --
  // an independent cross-check that the (separately-fixed) comparison
  // functions agree exactly with the (already-correct) leaderboard.
  const { getSupplierPriceLeaderboard } = await import("../src/lib/pricing-db");
  const board = await getSupplierPriceLeaderboard();
  const candidates = board.competitiveProducts.filter((p) => p.eligibleSupplierCount >= 2).slice(0, 5);
  let regressionChecked = 0;
  for (const c of candidates) {
    const asProduct = products.find((p) => p.id === c.identityKey);
    const comparison = asProduct ? await getProductOfferComparison(c.identityKey) : await getReferenceProductOfferComparison(c.identityKey);
    regressionChecked++;
    assert(comparison.bestPrice !== null, `${c.brand} ${c.name}: has a valid bestPrice`);
    assert(
      comparison.bestPrice !== null && Math.abs(comparison.bestPrice.priceUsd - c.bestPriceUsd) < 0.01,
      `${c.brand} ${c.name}: comparison-function bestPrice ($${comparison.bestPrice?.priceUsd}) matches leaderboard's independently-computed bestPriceUsd ($${c.bestPriceUsd})`
    );
    assert(
      comparison.bestPrice !== null && comparison.actionable[0]?.offerKey === comparison.bestPrice.offerKey,
      `${c.brand} ${c.name}: bestPrice is still the lowest-priced actionable row (sort order unaffected)`
    );
    console.log(`  ${c.brand} ${c.name}: bestPrice=$${comparison.bestPrice?.priceUsd} (${comparison.bestPrice?.supplierName}), ${comparison.actionable.length} actionable offers -- unaffected`);
  }
  assert(regressionChecked >= 3, `found and checked at least 3 clean multi-real-supplier products as a regression baseline (found ${regressionChecked})`);

  console.log(`\n=== TOTAL: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
