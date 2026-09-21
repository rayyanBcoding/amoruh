// READ-ONLY. Snapshots the reverse-index SET membership for every
// EXISTING reference product and every EXISTING real Product, before
// migration. These are additive-only from the migration's perspective
// (SADD, never SREM'd by it) so they're reconstructable from an offer-
// hash before/after diff alone -- but this captures them directly too,
// closing that gap rather than relying on inference.
import fs from "fs";
import path from "path";
import { getAllReferenceProducts, getOffersByReferenceProduct, getOffersByProduct } from "../src/lib/pricing-db";
import { getProducts } from "../src/lib/db";

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(__dirname, "..", "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `pre-migration-reverse-indexes-${timestamp}.json`);

  console.log("Reading all reference products and products...");
  const [referenceProducts, products] = await Promise.all([getAllReferenceProducts(), getProducts()]);

  const CHUNK = 100;
  console.log(`Snapshotting offers_by_reference_product for ${referenceProducts.length} reference products...`);
  const offersByReferenceProduct: Record<string, { supplierId: string; offerKey: string }[]> = {};
  let nonEmptyRefCount = 0;
  for (let i = 0; i < referenceProducts.length; i += CHUNK) {
    const chunk = referenceProducts.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map((rp) => getOffersByReferenceProduct(rp.id)));
    chunk.forEach((rp, idx) => {
      if (results[idx].length > 0) {
        offersByReferenceProduct[rp.id] = results[idx];
        nonEmptyRefCount++;
      }
    });
  }

  console.log(`Snapshotting offers_by_product for ${products.length} products...`);
  const offersByProduct: Record<string, { supplierId: string; offerKey: string }[]> = {};
  let nonEmptyProductCount = 0;
  for (let i = 0; i < products.length; i += CHUNK) {
    const chunk = products.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map((p) => getOffersByProduct(p.id)));
    chunk.forEach((p, idx) => {
      if (results[idx].length > 0) {
        offersByProduct[p.id] = results[idx];
        nonEmptyProductCount++;
      }
    });
  }

  const snapshot = {
    takenAt: new Date().toISOString(),
    purpose: "Pre-migration reverse-index snapshot (offers_by_reference_product, offers_by_product)",
    referenceProductsWithOffers: nonEmptyRefCount,
    productsWithOffers: nonEmptyProductCount,
    offersByReferenceProduct,
    offersByProduct,
  };
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  const stats = fs.statSync(outPath);
  console.log(`\nBackup written to: ${outPath}`);
  console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Reference products with at least one offer: ${nonEmptyRefCount}`);
  console.log(`Real products with at least one offer: ${nonEmptyProductCount}`);
}
main();
