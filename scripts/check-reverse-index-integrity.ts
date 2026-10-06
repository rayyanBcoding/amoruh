// READ-ONLY. General-purpose integrity checker for the
// offers_by_reference_product / offers_by_product reverse indexes:
// bidirectional consistency against every supplier's currently-
// committed offers. Two failure modes checked, each way:
//   1. Dangling membership — a reverse-index set contains a
//      {supplierId, offerKey} pair whose offer no longer points back at
//      that reference product/product (offer deleted, relinked
//      elsewhere, or unlinked and the SREM never happened).
//   2. Missing membership — an offer has a referenceProductId/productId
//      set, but is not a member of that identity's reverse-index set
//      (the exact bug PR "fix reverse index maintenance" originally
//      addressed for the manual-link paths).
// Zero writes. Safe to run any time, not specific to any one cleanup.
import { getCommittedOffers, getAllReferenceProducts, getOffersByReferenceProduct, getOffersByProduct } from "../src/lib/pricing-db";
import { getSuppliers } from "../src/lib/intake-db";
import { getProducts } from "../src/lib/db";
import type { SupplierOfferCurrent } from "../src/lib/pricing-types";

async function main() {
  const suppliers = await getSuppliers();
  const [products, referenceProducts] = await Promise.all([getProducts(), getAllReferenceProducts()]);
  console.log(`Suppliers: ${suppliers.length}, Products: ${products.length}, Reference products: ${referenceProducts.length}`);

  console.log("Fetching all committed offers...");
  const offersBySupplier = await Promise.all(suppliers.map((s) => getCommittedOffers(s.id)));

  // Expected membership derived straight from the offers themselves.
  const expectedByReferenceProduct = new Map<string, Set<string>>();
  const expectedByProduct = new Map<string, Set<string>>();
  let offersWithReferenceProductId = 0;
  let offersWithProductId = 0;

  for (let i = 0; i < suppliers.length; i++) {
    for (const o of Object.values(offersBySupplier[i]) as SupplierOfferCurrent[]) {
      const member = `${o.supplierId}::${o.offerKey}`;
      if (o.referenceProductId) {
        offersWithReferenceProductId++;
        if (!expectedByReferenceProduct.has(o.referenceProductId)) expectedByReferenceProduct.set(o.referenceProductId, new Set());
        expectedByReferenceProduct.get(o.referenceProductId)!.add(member);
      }
      if (o.productId) {
        offersWithProductId++;
        if (!expectedByProduct.has(o.productId)) expectedByProduct.set(o.productId, new Set());
        expectedByProduct.get(o.productId)!.add(member);
      }
    }
  }
  console.log(`Offers with referenceProductId set: ${offersWithReferenceProductId}`);
  console.log(`Offers with productId set: ${offersWithProductId}`);

  const missingFromIndex: string[] = [];
  const danglingInIndex: string[] = [];

  console.log(`\nChecking offers_by_reference_product for ${expectedByReferenceProduct.size} reference products with offers...`);
  for (const [rpId, expectedMembers] of expectedByReferenceProduct) {
    const actual = await getOffersByReferenceProduct(rpId);
    const actualSet = new Set(actual.map((m) => `${m.supplierId}::${m.offerKey}`));
    for (const m of expectedMembers) if (!actualSet.has(m)) missingFromIndex.push(`referenceProduct ${rpId}: offer ${m} points to it but is not in its reverse index`);
    for (const m of actualSet) if (!expectedMembers.has(m)) danglingInIndex.push(`referenceProduct ${rpId}: reverse index contains ${m} but that offer no longer points to it`);
  }

  console.log(`Checking offers_by_product for ${expectedByProduct.size} products with offers...`);
  for (const [pId, expectedMembers] of expectedByProduct) {
    const actual = await getOffersByProduct(pId);
    const actualSet = new Set(actual.map((m) => `${m.supplierId}::${m.offerKey}`));
    for (const m of expectedMembers) if (!actualSet.has(m)) missingFromIndex.push(`product ${pId}: offer ${m} points to it but is not in its reverse index`);
    for (const m of actualSet) if (!expectedMembers.has(m)) danglingInIndex.push(`product ${pId}: reverse index contains ${m} but that offer no longer points to it`);
  }

  console.log(`\n=== RESULT ===`);
  console.log(`Missing-from-index problems: ${missingFromIndex.length}`);
  console.log(`Dangling-in-index problems: ${danglingInIndex.length}`);
  if (missingFromIndex.length) console.log(missingFromIndex.slice(0, 50).map((m) => `  ${m}`).join("\n"));
  if (danglingInIndex.length) console.log(danglingInIndex.slice(0, 50).map((m) => `  ${m}`).join("\n"));
  console.log(missingFromIndex.length === 0 && danglingInIndex.length === 0 ? "\nReverse indexes fully consistent." : "\n*** REVERSE INDEX INCONSISTENCIES FOUND ***");
}
main();
