// READ-ONLY: confirms the new safeguard would have caught the REAL
// Dior Homme / Miss Dior incident using the exact real production data
// (not synthetic strings), by replicating exactly what
// linkOfferToReferenceProduct now does internally -- without ever
// calling the actual write path. No writes performed.
import { getCurrentOffer, getReferenceProduct } from "../src/lib/pricing-db";
import { extractAttributes, checkManualLinkCompatibility } from "../src/lib/pricing-matching";

async function main() {
  const supplierId = "sup_1788861090903_xj9mqr"; // Jizan
  const dioHommeOfferKey = "sku:01cd10048000002-010020-0125cfr";
  const missDiorReferenceProductId = "refprod_1789344177599_3vyi1u";

  const [offer, referenceProduct] = await Promise.all([getCurrentOffer(supplierId, dioHommeOfferKey), getReferenceProduct(missDiorReferenceProductId)]);

  if (!offer || !referenceProduct) {
    console.log("Could not fetch real records -- catalog may have changed since the original trace.");
    return;
  }

  console.log(`Offer: "${offer.brand} ${offer.description}" upc=${offer.upc} ean=${offer.ean}`);
  console.log(`Target: "${referenceProduct.brand} ${referenceProduct.name}" upc=${referenceProduct.upc} ean=${referenceProduct.ean}`);

  const offerAttrs = extractAttributes(`${offer.brand} ${offer.description}`, offer.brand);
  const targetAttrs = extractAttributes(`${referenceProduct.brand} ${referenceProduct.description}`, referenceProduct.brand);
  const compatibility = checkManualLinkCompatibility(
    { attrs: offerAttrs, upc: offer.upc, ean: offer.ean },
    { attrs: targetAttrs, upc: referenceProduct.upc, ean: referenceProduct.ean }
  );

  console.log(`\ncompatible: ${compatibility.compatible}`);
  console.log(`confidence: ${compatibility.confidence}`);
  console.log(`warnings:`);
  for (const w of compatibility.warnings) console.log(`  [${w.field}] ${w.message}`);

  if (compatibility.compatible) {
    console.error("\n*** FAIL: the real incident would NOT be caught by this safeguard ***");
    process.exit(1);
  } else {
    console.log("\nCONFIRMED: linkOfferToReferenceProduct would now refuse this exact link without confirmOverride, and show these exact warnings.");
  }
}
main();
