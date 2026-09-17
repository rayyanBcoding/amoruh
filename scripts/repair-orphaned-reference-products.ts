// Repairs the exact orphaned records identified by
// audit-orphaned-reference-products.ts: a manual_track Master Product
// whose originating offer STILL exists and STILL points at it
// (originatingOffer.referenceProductId === rp.id) but is missing from
// offers_by_reference_product — the precise shape of gap the
// applyReferenceLink bug fix (pricing-reference-linking.ts) closes for
// all future links. This repairs only the two records already found:
// re-verifies each is still in exactly that state, then backfills.
//
//   --dry-run (default): zero writes, just re-verifies and reports.
//   --execute --confirm-production: performs the actual backfill.
//
// backfillOfferByReferenceProduct is a plain idempotent SADD — never
// touches SupplierOfferCurrent, never creates/merges/deletes anything,
// never touched based on name similarity (both records here were
// already independently verified: exact provenance match, offer still
// exists, offer.referenceProductId already equals this exact record).

import { getReferenceProduct, getCurrentOffer, getOffersByReferenceProduct, backfillOfferByReferenceProduct } from "../src/lib/pricing-db";

const EXECUTE = process.argv.includes("--execute");
const CONFIRMED = process.argv.includes("--confirm-production");

const CANDIDATES = [
  { referenceProductId: "refprod_1789605019708_as2b0w", supplierId: "sup_1788501195138_m20jq4", offerKey: "sku:3616303322021" },
  { referenceProductId: "refprod_1789605114137_nmrer5", supplierId: "sup_1789274724006_ejp88h", offerKey: "sku:850051043439" },
];

async function main() {
  if (EXECUTE && !CONFIRMED) {
    console.error("--execute requires --confirm-production. Refusing to run.");
    process.exit(1);
  }

  for (const c of CANDIDATES) {
    const [rp, offer, existingRefs] = await Promise.all([
      getReferenceProduct(c.referenceProductId),
      getCurrentOffer(c.supplierId, c.offerKey),
      getOffersByReferenceProduct(c.referenceProductId),
    ]);

    if (!rp) {
      console.log(`SKIP  ${c.referenceProductId} -> Master Product no longer exists`);
      continue;
    }
    if (!offer) {
      console.log(`SKIP  ${c.referenceProductId} -> originating offer no longer exists`);
      continue;
    }
    if (offer.referenceProductId !== c.referenceProductId) {
      console.log(`SKIP  ${c.referenceProductId} -> offer's referenceProductId changed to "${offer.referenceProductId}" since the audit — do not blindly repair`);
      continue;
    }
    const alreadyPresent = existingRefs.some((r) => r.supplierId === c.supplierId && r.offerKey === c.offerKey);
    if (alreadyPresent) {
      console.log(`SKIP  ${c.referenceProductId} -> already present in the reverse index (repaired by something else already)`);
      continue;
    }

    if (EXECUTE) {
      await backfillOfferByReferenceProduct(c.referenceProductId, c.supplierId, c.offerKey);
      console.log(`REPAIRED  ${c.referenceProductId} ("${rp.brand} ${rp.name}") <- ${c.supplierId}/${c.offerKey}`);
    } else {
      console.log(`WOULD REPAIR  ${c.referenceProductId} ("${rp.brand} ${rp.name}") <- ${c.supplierId}/${c.offerKey}`);
    }
  }
}
main();
