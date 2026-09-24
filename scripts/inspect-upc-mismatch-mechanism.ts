// READ-ONLY: for a sample of the flagged "matchType=upc" cross-fragrance
// pairs, pull the raw upc/ean fields on both offending offers AND on the
// Master Product record itself, to determine the exact mechanism: do
// the two different physical products share the identical barcode value
// in the supplier's own data (a supplier data-quality error the system
// correctly followed), or does the Master Product's own upc/ean fields
// disagree with one of the offers (a genuine identity-assignment bug)?
import { getReferenceProduct, getCurrentOffer } from "../src/lib/pricing-db";

const SAMPLE: { referenceProductId: string; supplierId: string; offerKey: string }[] = [
  { referenceProductId: "refprod_1789344177599_3vyi1u", supplierId: "sup_1788861090903_xj9mqr", offerKey: "sku:01cd10001000001-010020-0125cfr" }, // Miss Dior (the one confirmed correct)
  { referenceProductId: "refprod_1789344177599_3vyi1u", supplierId: "sup_1788861090903_xj9mqr", offerKey: "sku:01cd10048000002-010020-0125cfr" }, // Dior Homme (the false link, matchType=manual)
  { referenceProductId: "refprod_1789342889769_w1mln3", supplierId: "sup_1788501195138_m20jq4", offerKey: "sku:3595472041226" }, // Mercedes Benz Club
  { referenceProductId: "refprod_1789342889769_w1mln3", supplierId: "sup_1788861090903_xj9mqr", offerKey: "sku:01mb40010000010-014981-0020cfr" }, // Mercedes Benz Select
  { referenceProductId: "refprod_1789344183997_z8exzy", supplierId: "sup_1788501195138_m20jq4", offerKey: "sku:8057971183975" }, // D&G Pour Femme
  { referenceProductId: "refprod_1789344183997_z8exzy", supplierId: "sup_1788861090903_xj9mqr", offerKey: "sku:01dg10004000001-054057-0100cfr" }, // D&G Light Blue
  { referenceProductId: "refprod_1789700820246_xs480d", supplierId: "sup_1788501195138_m20jq4", offerKey: "sku:8054754401059" }, // D&G Devotion
  { referenceProductId: "refprod_1789700820246_xs480d", supplierId: "sup_1788861090903_xj9mqr", offerKey: "sku:01dg10041000014-011471-0100cit" }, // D&G K Pour Homme Intense
];

async function main() {
  for (const s of SAMPLE) {
    const [rp, offer] = await Promise.all([getReferenceProduct(s.referenceProductId), getCurrentOffer(s.supplierId, s.offerKey)]);
    console.log(`\nMaster Product ${s.referenceProductId}: "${rp?.brand} ${rp?.name}" -- record upc="${rp?.upc}" ean="${rp?.ean}"`);
    console.log(`  Offer ${s.offerKey}: "${offer?.description}" -- offer upc="${offer?.upc}" ean="${offer?.ean}" matchType=${offer?.matchType} matchConfidence=${offer?.matchConfidence}`);
    if (rp && offer) {
      const upcMatches = Boolean(offer.upc) && offer.upc === rp.upc;
      const eanMatches = Boolean(offer.ean) && offer.ean === rp.ean;
      const crossMatches = (Boolean(offer.upc) && offer.upc === rp.ean) || (Boolean(offer.ean) && offer.ean === rp.upc);
      console.log(`  offer.upc === record.upc? ${upcMatches} | offer.ean === record.ean? ${eanMatches} | cross upc<->ean match? ${crossMatches}`);
    }
  }
}
main();
