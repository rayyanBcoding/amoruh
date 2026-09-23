// Read-only: of the Master Products touched by an orphaned-supplier
// offer, how many have ZERO real-supplier coverage at all (would show
// "no actionable offer" once orphaned offers are filtered) vs. some real
// coverage (would just lose the fake entries, real price still shows)?
import { getCommittedOffers, getSupplierPriceLeaderboard } from "../src/lib/pricing-db";

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

async function main() {
  const affectedReferenceProductIds = new Set<string>();
  const affectedProductIds = new Set<string>();
  for (const supplierId of ORPHANED_SUPPLIER_IDS) {
    const offers = await getCommittedOffers(supplierId);
    for (const o of Object.values(offers)) {
      if (o.referenceProductId) affectedReferenceProductIds.add(o.referenceProductId);
      if (o.productId) affectedProductIds.add(o.productId);
    }
  }

  const board = await getSupplierPriceLeaderboard();
  const hasRealCoverage = new Set([...board.competitiveProducts.map((p) => p.identityKey), ...board.singleSupplierProducts.map((p) => p.identityKey)]);

  let zeroRealCoverage = 0;
  let someRealCoverage = 0;
  for (const id of affectedReferenceProductIds) {
    if (hasRealCoverage.has(id)) someRealCoverage++;
    else zeroRealCoverage++;
  }
  for (const id of affectedProductIds) {
    if (hasRealCoverage.has(id)) someRealCoverage++;
    else zeroRealCoverage++;
  }

  console.log(`Affected Master Products total: ${affectedReferenceProductIds.size + affectedProductIds.size}`);
  console.log(`  With ZERO real-supplier coverage (would show "no actionable offer" once filtered): ${zeroRealCoverage}`);
  console.log(`  With SOME real-supplier coverage (real price already exists, just currently contaminated by a fake competing entry): ${someRealCoverage}`);
}
main();
