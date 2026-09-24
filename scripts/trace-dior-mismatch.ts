// READ-ONLY trace of the reported Miss Dior / Dior Homme mismatch:
// two different fragrances (different UPC, different name) both
// appearing under one Master Product. No writes.
import {
  getReferenceProductByUpc,
  getOffersByReferenceProduct,
  getOffersByProduct,
  getCurrentOffer,
  getAliasesForSupplier,
  getAllReferenceProducts,
} from "../src/lib/pricing-db";
import { getSuppliers } from "../src/lib/intake-db";
import { getProducts } from "../src/lib/db";
import { extractAttributes, computeIdentitySignature, resolveEffectiveBrand } from "../src/lib/pricing-matching";

const MISS_DIOR_UPC = "3348901709026";
const DIOR_HOMME_UPC = "3348901755504";

async function main() {
  const suppliers = await getSuppliers();
  const jizan = suppliers.find((s) => s.name.toLowerCase().includes("jizan"));
  if (!jizan) {
    console.log("Jizan supplier not found.");
    return;
  }
  console.log(`Jizan supplierId: ${jizan.id}`);

  // --- Step 1: find the Miss Dior Master Product by its own UPC pointer ---
  const missDiorRp = await getReferenceProductByUpc(MISS_DIOR_UPC);
  console.log(`\n=== Reference product owning UPC ${MISS_DIOR_UPC} (Miss Dior) ===`);
  console.log(missDiorRp ? JSON.stringify(missDiorRp, null, 2) : "NOT FOUND via UPC pointer");

  const dhByUpc = await getReferenceProductByUpc(DIOR_HOMME_UPC);
  console.log(`\n=== Reference product owning UPC ${DIOR_HOMME_UPC} (Dior Homme) via UPC pointer ===`);
  console.log(dhByUpc ? JSON.stringify(dhByUpc, null, 2) : "NOT FOUND via UPC pointer (expected if it was never separately created)");

  // Also check if either UPC belongs to a real Product instead.
  const products = await getProducts();
  const missDiorProduct = products.find((p) => p.barcode === MISS_DIOR_UPC);
  const diorHommeProduct = products.find((p) => p.barcode === DIOR_HOMME_UPC);
  console.log(`\nReal Product with barcode ${MISS_DIOR_UPC}: ${missDiorProduct ? `${missDiorProduct.id} "${missDiorProduct.brand} ${missDiorProduct.name}"` : "none"}`);
  console.log(`Real Product with barcode ${DIOR_HOMME_UPC}: ${diorHommeProduct ? `${diorHommeProduct.id} "${diorHommeProduct.brand} ${diorHommeProduct.name}"` : "none"}`);

  const targetIdentity = missDiorRp?.id ?? missDiorProduct?.id;
  if (!targetIdentity) {
    console.log("\nCould not resolve the Miss Dior Master Product identity by UPC -- searching by name instead.");
    const allRefs = await getAllReferenceProducts();
    const byName = allRefs.filter((rp) => rp.brand.toUpperCase().includes("DIOR") && rp.name.toUpperCase().includes("MISS DIOR"));
    console.log(`Found ${byName.length} reference product(s) with "DIOR" brand + "MISS DIOR" in name:`);
    for (const rp of byName) console.log(`  ${rp.id}: "${rp.brand} ${rp.name}" upc=${rp.upc} ean=${rp.ean} sizeMl=${rp.sizeMl} concentration=${rp.concentration}`);
    return;
  }

  // --- Step 2: every offer currently linked to that Master Product ---
  const isRealProduct = Boolean(missDiorProduct);
  const refs = isRealProduct ? await getOffersByProduct(targetIdentity) : await getOffersByReferenceProduct(targetIdentity);
  console.log(`\n=== Every offer linked to Master Product ${targetIdentity} (${refs.length} total) ===`);
  for (const r of refs) {
    const offer = await getCurrentOffer(r.supplierId, r.offerKey);
    const supplierName = suppliers.find((s) => s.id === r.supplierId)?.name ?? "unknown";
    if (!offer) {
      console.log(`  [${supplierName}] ${r.offerKey} -> OFFER NO LONGER EXISTS`);
      continue;
    }
    console.log(`  [${supplierName}] ${r.offerKey}`);
    console.log(`    description: "${offer.description}"`);
    console.log(`    brand field: "${offer.brand}"`);
    console.log(`    upc=${offer.upc} ean=${offer.ean}`);
    console.log(`    price=${offer.price} ${offer.currency}, qty=${offer.quantity}, currentlyListed=${offer.currentlyListed}`);
    console.log(`    productId=${offer.productId} referenceProductId=${offer.referenceProductId}`);
    console.log(`    matchType=${offer.matchType} matchConfidence=${offer.matchConfidence} reviewStatus=${offer.reviewStatus}`);
    console.log(`    candidateProductId=${offer.candidateProductId} candidateReferenceProductId=${offer.candidateReferenceProductId}`);
    console.log(`    rejectedCandidateProductIds=${JSON.stringify(offer.rejectedCandidateProductIds ?? [])}`);
  }

  // --- Step 3: find the Dior Homme offer directly in Jizan's current offers by UPC/description ---
  const { getCommittedOffers } = await import("../src/lib/pricing-db");
  const jizanOffers = await getCommittedOffers(jizan.id);
  const diorHommeOffers = Object.values(jizanOffers).filter(
    (o) => o.upc === DIOR_HOMME_UPC || o.ean === DIOR_HOMME_UPC || o.description.toUpperCase().includes("DIOR HOMME")
  );
  console.log(`\n=== Jizan's own current offer(s) matching Dior Homme UPC/description (${diorHommeOffers.length}) ===`);
  for (const o of diorHommeOffers) {
    console.log(`  offerKey=${o.offerKey}`);
    console.log(`    description: "${o.description}"`);
    console.log(`    upc=${o.upc} ean=${o.ean}`);
    console.log(`    productId=${o.productId} referenceProductId=${o.referenceProductId}`);
    console.log(`    matchType=${o.matchType} matchConfidence=${o.matchConfidence} reviewStatus=${o.reviewStatus}`);
    console.log(`    lastUploadId=${(o as unknown as { lastUploadId?: string }).lastUploadId}`);
  }

  const missDiorOffers = Object.values(jizanOffers).filter(
    (o) => o.upc === MISS_DIOR_UPC || o.ean === MISS_DIOR_UPC || o.description.toUpperCase().includes("MISS DIOR")
  );
  console.log(`\n=== Jizan's own current offer(s) matching Miss Dior UPC/description (${missDiorOffers.length}) ===`);
  for (const o of missDiorOffers) {
    console.log(`  offerKey=${o.offerKey}`);
    console.log(`    description: "${o.description}"`);
    console.log(`    upc=${o.upc} ean=${o.ean}`);
    console.log(`    productId=${o.productId} referenceProductId=${o.referenceProductId}`);
    console.log(`    matchType=${o.matchType} matchConfidence=${o.matchConfidence} reviewStatus=${o.reviewStatus}`);
  }

  // --- Step 4: alias history for Jizan ---
  const aliases = await getAliasesForSupplier(jizan.id);
  console.log(`\n=== Jizan alias history (${aliases.length} total) -- checking for the Dior Homme offerKey ===`);
  for (const o of diorHommeOffers) {
    const matchingAliases = aliases.filter((a) => a.offerKey === o.offerKey);
    console.log(`  offerKey=${o.offerKey}: ${matchingAliases.length} alias record(s)`);
    for (const a of matchingAliases) console.log(`    ${JSON.stringify(a)}`);
  }

  // --- Step 5: identity signature check -- do Miss Dior and Dior Homme collapse to the same signature? ---
  console.log(`\n=== Identity signature comparison ===`);
  const missDiorText = "CHRISTIAN DIOR MISS DIOR (W) PARFUM 125 ml FR";
  const diorHommeText = "CHRISTIAN DIOR DIOR HOMME (M) PARFUM 125 ml FR";
  const missDiorBrand = resolveEffectiveBrand({ brand: "CHRISTIAN DIOR", description: missDiorText }, products, await getAllReferenceProducts());
  const diorHommeBrand = resolveEffectiveBrand({ brand: "CHRISTIAN DIOR", description: diorHommeText }, products, await getAllReferenceProducts());
  const missDiorAttrs = extractAttributes(missDiorText, missDiorBrand);
  const diorHommeAttrs = extractAttributes(diorHommeText, diorHommeBrand);
  console.log(`Miss Dior attrs: brand="${missDiorAttrs.brandToken}" coreTokens=${JSON.stringify(missDiorAttrs.coreNameTokens)} size=${missDiorAttrs.sizeMl} conc=${missDiorAttrs.concentration} form=${missDiorAttrs.productForm}`);
  console.log(`Dior Homme attrs: brand="${diorHommeAttrs.brandToken}" coreTokens=${JSON.stringify(diorHommeAttrs.coreNameTokens)} size=${diorHommeAttrs.sizeMl} conc=${diorHommeAttrs.concentration} form=${diorHommeAttrs.productForm}`);
  const missDiorSig = computeIdentitySignature(missDiorAttrs);
  const diorHommeSig = computeIdentitySignature(diorHommeAttrs);
  console.log(`Miss Dior signature: ${missDiorSig}`);
  console.log(`Dior Homme signature: ${diorHommeSig}`);
  console.log(`Signatures identical? ${missDiorSig === diorHommeSig}`);
}
main();
