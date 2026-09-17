// Repairs the exact orphaned records identified by
// audit-orphaned-reference-products.ts: a manual_track Master Product
// whose originating offer STILL exists and STILL points at it
// (originatingOffer.referenceProductId === rp.id) but is missing from
// offers_by_reference_product — the precise shape of gap the
// applyReferenceLink bug fix (pricing-reference-linking.ts) closes for
// all future links. This repairs only the two records already found:
// re-verifies each is still in exactly that state, then repairs BOTH
// halves of the gap:
//   1. offers_by_reference_product (backfillOfferByReferenceProduct —
//      plain idempotent SADD).
//   2. The offer's own reviewStatus/matchType/reviewRequestedAt, which
//      for these two PRE-FIX records are still stuck at whatever they
//      were before applyReferenceLink was fixed (typically
//      "needs_review") — not "confirmed"/"manual" the way a link made
//      through the fixed code now produces. Without this second half,
//      the comparison page would show the offer in "Not Currently
//      Actionable" ("...still awaiting match review") instead of as a
//      normal actionable price, even after the reverse index is fixed.
//      applyReferenceLink itself can't be reused here unchanged — it
//      only issues writes when referenceProductId is actually CHANGING,
//      and here it's already correct on the offer; this script performs
//      the equivalent of what applyReferenceLink would have done
//      correctly the first time, explicitly, via resolveOfferManually.
//
//   --dry-run (default): zero writes, just re-verifies and reports the
//     exact before/after offer state.
//   --execute --confirm-production: performs the actual repair.
//
// Never touches referenceProductId itself (already correct), never
// creates/merges/deletes anything, never touched based on name
// similarity — both records here were already independently verified:
// exact provenance match, offer still exists, offer.referenceProductId
// already equals this exact record.

import {
  getReferenceProduct,
  getCurrentOffer,
  getOffersByReferenceProduct,
  backfillOfferByReferenceProduct,
  getAliasesForSupplier,
  resolveOfferManually,
} from "../src/lib/pricing-db";

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

    const indexPresent = existingRefs.some((r) => r.supplierId === c.supplierId && r.offerKey === c.offerKey);
    const statusAlreadyCorrect = offer.reviewStatus === "confirmed" && offer.matchType === "manual";

    if (indexPresent && statusAlreadyCorrect) {
      console.log(`SKIP  ${c.referenceProductId} -> already fully repaired (index present, reviewStatus/matchType already correct)`);
      continue;
    }

    console.log(`${c.referenceProductId} ("${rp.brand} ${rp.name}") <- ${c.supplierId}/${c.offerKey}`);
    console.log(`  index present: ${indexPresent}${indexPresent ? "" : " -> will SADD"}`);
    console.log(`  reviewStatus: "${offer.reviewStatus}", matchType: "${offer.matchType}"${statusAlreadyCorrect ? "" : ' -> will set "confirmed"/"manual"'}`);

    if (EXECUTE) {
      if (!indexPresent) await backfillOfferByReferenceProduct(c.referenceProductId, c.supplierId, c.offerKey);
      if (!statusAlreadyCorrect) {
        const currentAliases = await getAliasesForSupplier(c.supplierId);
        await resolveOfferManually({
          supplierId: c.supplierId,
          offerKey: c.offerKey,
          updatedOffer: { ...offer, matchType: "manual", reviewStatus: "confirmed", reviewRequestedAt: null },
          newAliases: currentAliases,
          offersByProductOps: [],
        });
      }
      console.log(`  REPAIRED`);
    } else {
      console.log(`  WOULD REPAIR (dry run)`);
    }
  }
}
main();
