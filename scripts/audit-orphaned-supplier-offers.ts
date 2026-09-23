// READ-ONLY audit of every offer whose supplierId no longer maps to a
// current supplier. Does not modify any data. Answers exactly what was
// asked: total orphaned offers, total affected Master Products, which
// deleted supplierIds they came from, whether original names are
// recoverable, whether a current supplier already covers the same
// identity/offerKey, and whether the EXISTING (pre-dating the new
// dashboard) detail-page comparison functions can currently surface an
// orphaned offer as the displayed "Best Price."
import { redis } from "../src/lib/kv";
import {
  getCommittedOffers,
  getUploadsForSupplier,
  getAliasesForSupplier,
  getReferenceProduct,
  getProductOfferComparison,
  getReferenceProductOfferComparison,
} from "../src/lib/pricing-db";
import { getSuppliers } from "../src/lib/intake-db";
import { getProducts } from "../src/lib/db";

async function scanAllKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = (await redis.scan(cursor, { match: pattern, count: 500 })) as [string, string[]];
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  return keys;
}

async function main() {
  const realSuppliers = await getSuppliers();
  const realIds = new Set(realSuppliers.map((s) => s.id));
  console.log(`Current real suppliers (${realSuppliers.length}): ${realSuppliers.map((s) => s.name).join(", ")}`);

  // Step 1: every supplierId that EVER committed a generation, real or not.
  const genIdKeys = await scanAllKeys("amoruh:pricing:current_generation_id:*");
  const allSupplierIdsEver = genIdKeys.map((k) => k.slice("amoruh:pricing:current_generation_id:".length));
  const orphanedIds = allSupplierIdsEver.filter((id) => !realIds.has(id));
  console.log(`\nTotal supplierIds that ever committed a generation: ${allSupplierIdsEver.length}`);
  console.log(`Orphaned (no longer a real supplier): ${orphanedIds.length}`);
  console.log(`Orphaned IDs: ${orphanedIds.join(", ")}`);

  // Step 2: pull every orphaned supplier's own current offers directly
  // (getCommittedOffers works off the generation pointer, independent of
  // whether a Supplier record exists).
  let totalOrphanedOffers = 0;
  let totalCurrentlyListedOrphanedOffers = 0;
  const affectedReferenceProductIds = new Set<string>();
  const affectedProductIds = new Set<string>();
  const orphanedOfferKeysByIdentity = new Map<string, { supplierId: string; offerKey: string; price: number; currentlyListed: boolean }[]>();

  for (const supplierId of orphanedIds) {
    const offers = await getCommittedOffers(supplierId);
    const offerList = Object.values(offers);
    totalOrphanedOffers += offerList.length;
    for (const o of offerList) {
      if (o.currentlyListed) totalCurrentlyListedOrphanedOffers++;
      const identity = o.referenceProductId ?? o.productId;
      if (identity) {
        if (o.referenceProductId) affectedReferenceProductIds.add(o.referenceProductId);
        if (o.productId) affectedProductIds.add(o.productId);
        if (!orphanedOfferKeysByIdentity.has(identity)) orphanedOfferKeysByIdentity.set(identity, []);
        orphanedOfferKeysByIdentity.get(identity)!.push({ supplierId, offerKey: o.offerKey, price: o.price, currentlyListed: o.currentlyListed });
      }
    }

    // Step 3: recoverability -- any upload history or aliases under this id?
    const [uploads, aliases] = await Promise.all([getUploadsForSupplier(supplierId, 20), getAliasesForSupplier(supplierId)]);
    console.log(`\n[${supplierId}] ${offerList.length} offers (${offerList.filter((o) => o.currentlyListed).length} currently listed), ${uploads.length} upload record(s), ${aliases.length} alias(es)`);
    if (uploads.length > 0) {
      for (const u of uploads) console.log(`    upload: "${u.filename}" (${u.status}, started ${u.startedAt})`);
    } else {
      console.log(`    NO upload records at all -- this supplierId never went through the normal upload pipeline; its offer/generation data was created some other way (likely direct test-data injection).`);
    }
  }

  console.log(`\n=== TOTALS ===`);
  console.log(`Total orphaned offers (all orphaned supplierIds combined): ${totalOrphanedOffers}`);
  console.log(`Of which currently-listed (currentlyListed=true): ${totalCurrentlyListedOrphanedOffers}`);
  console.log(`Distinct affected Master Products (referenceProductId): ${affectedReferenceProductIds.size}`);
  console.log(`Distinct affected real Products (productId): ${affectedProductIds.size}`);

  // Step 4: for identities with an orphaned offer, does a REAL supplier
  // already have an offer under the EXACT SAME offerKey (would indicate
  // the item was simply re-uploaded/re-attributed under a real supplier
  // and the orphaned copy is pure redundant garbage)?
  console.log(`\n=== Identity/offerKey overlap with current suppliers (sample of 25) ===`);
  const sampleIdentities = [...orphanedOfferKeysByIdentity.entries()].slice(0, 25);
  const realOffersBySupplier = await Promise.all(realSuppliers.map((s) => getCommittedOffers(s.id)));
  let overlapCount = 0;
  for (const [, orphanRows] of sampleIdentities) {
    let sharedOfferKey = false;
    for (let i = 0; i < realSuppliers.length; i++) {
      for (const key of Object.keys(realOffersBySupplier[i])) {
        if (orphanRows.some((r) => r.offerKey === key)) sharedOfferKey = true;
      }
    }
    if (sharedOfferKey) overlapCount++;
  }
  console.log(`${overlapCount} of ${sampleIdentities.length} sampled identities have a current supplier using the IDENTICAL offerKey string (only meaningful if that current supplier is a coincidentally-identical SKU, not necessarily the "same" historical listing).`);

  // Step 5: does this ALREADY affect the "Current Best Price" hero on
  // the EXISTING (pre-dating this audit) detail pages? Sample check.
  console.log(`\n=== Does an orphaned offer currently win "Best Price" on the EXISTING detail page? (sample of 15) ===`);
  const products = await getProducts();
  let bestPriceIsOrphanedCount = 0;
  let checked = 0;
  for (const [identity] of [...orphanedOfferKeysByIdentity.entries()].slice(0, 15)) {
    checked++;
    const asProduct = products.find((p) => p.id === identity);
    const comparison = asProduct ? await getProductOfferComparison(identity) : await getReferenceProductOfferComparison(identity);
    const bestSupplierIsReal = comparison.bestPrice ? realIds.has(comparison.bestPrice.supplierId) : true;
    const label = asProduct ? `${asProduct.brand} ${asProduct.name}` : (await getReferenceProduct(identity))?.name ?? identity;
    if (comparison.bestPrice && !bestSupplierIsReal) {
      bestPriceIsOrphanedCount++;
      console.log(`  *** ${label}: CURRENT BEST PRICE is $${comparison.bestPrice.priceUsd} from supplier "${comparison.bestPrice.supplierName}" -- an ORPHANED/deleted supplier ***`);
    } else if (comparison.bestPrice) {
      console.log(`  ${label}: best price $${comparison.bestPrice.priceUsd} from "${comparison.bestPrice.supplierName}" (real, current supplier) -- OK`);
    } else {
      console.log(`  ${label}: no actionable best price at all`);
    }
  }
  console.log(`\n${bestPriceIsOrphanedCount} of ${checked} sampled products currently show an ORPHANED supplier's price as their "Current Best Price" hero on the existing /pricing/products or /pricing/reference-products detail page.`);
}
main();
