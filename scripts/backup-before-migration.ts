// READ-ONLY pre-migration snapshot. Dumps every PricingReferenceProduct
// and every supplier's currently-committed offer hash to a local,
// timestamped JSON file, BEFORE the real migration executes.
//
// Why this exists: bulkUpdateOffers (the migration's offer-write
// primitive) does NOT call writeSnapshotsBatch/offerHistory -- that
// history mechanism is only wired into the normal upload-processing
// path (pricing-process.ts). A migration-touched offer therefore has NO
// automatic "before" record anywhere in Redis. Newly-created Master
// Products ARE self-identifying after the fact (every one gets
// createdBy: "backlog_migration" + createdFromSupplierId/UploadId/
// OfferKey), but a MODIFIED existing offer has no such marker -- this
// snapshot is what makes "exactly what changed, and what was it before"
// answerable for both cases, and is the concrete artifact recovery
// would restore from if anything needs to be undone.
//
// Zero writes. Safe to run any number of times.
import fs from "fs";
import path from "path";
import { getSuppliers } from "../src/lib/intake-db";
import { getCommittedOffers, getAllReferenceProducts, getCurrentGenerationId } from "../src/lib/pricing-db";

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(__dirname, "..", "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `pre-migration-backup-${timestamp}.json`);

  console.log("Reading all reference products...");
  const referenceProducts = await getAllReferenceProducts();

  console.log("Reading all suppliers and their currently-committed offers...");
  const suppliers = await getSuppliers();
  const offersBySupplier: Record<string, { supplierName: string; generationId: string | null; offers: Record<string, unknown> }> = {};
  let totalOffers = 0;
  for (const s of suppliers) {
    const [generationId, offers] = await Promise.all([getCurrentGenerationId(s.id), getCommittedOffers(s.id)]);
    offersBySupplier[s.id] = { supplierName: s.name, generationId, offers };
    totalOffers += Object.keys(offers).length;
  }

  const snapshot = {
    takenAt: new Date().toISOString(),
    purpose: "Pre-migration backup — restore point before scripts/migrate-backlog-dry-run.ts --execute --confirm-production",
    referenceProductCount: referenceProducts.length,
    totalOfferCount: totalOffers,
    referenceProducts,
    offersBySupplier,
  };

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  const stats = fs.statSync(outPath);
  console.log(`\nBackup written to: ${outPath}`);
  console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Reference products captured: ${referenceProducts.length}`);
  console.log(`Suppliers captured: ${suppliers.length}`);
  console.log(`Total offers captured: ${totalOffers}`);
}
main();
