// READ-ONLY. Compares a pre-migration backup (from
// backup-before-migration.ts) against CURRENT production state and
// reports exactly what a targeted, selective restore would need to
// touch -- never a full database reset. Zero writes; this only ever
// PRINTS what a restore would do.
//
// Usage: npx tsx --env-file=.env.development.local scripts/recovery-diff.ts <backup-file-path>
import fs from "fs";
import { getSuppliers } from "../src/lib/intake-db";
import { getCommittedOffers, getAllReferenceProducts } from "../src/lib/pricing-db";
import type { PricingReferenceProduct, SupplierOfferCurrent } from "../src/lib/pricing-types";

async function main() {
  const backupPath = process.argv[2];
  if (!backupPath) {
    console.error("Usage: npx tsx scripts/recovery-diff.ts <backup-file-path>");
    process.exit(1);
  }
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  const backupRefById = new Map<string, PricingReferenceProduct>(backup.referenceProducts.map((rp: PricingReferenceProduct) => [rp.id, rp]));

  console.log(`Backup taken at: ${backup.takenAt}`);
  console.log(`Backup reference products: ${backup.referenceProducts.length}`);

  const currentRefs = await getAllReferenceProducts();
  console.log(`Current reference products: ${currentRefs.length}`);

  const newlyCreated = currentRefs.filter((rp) => !backupRefById.has(rp.id));
  console.log(`\n=== Reference products that exist NOW but NOT in the backup (candidates for deletion if reverting) ===`);
  console.log(`Count: ${newlyCreated.length}`);
  const migrationCreated = newlyCreated.filter((rp) => rp.createdBy === "backlog_migration");
  console.log(`  Of which tagged createdBy="backlog_migration" (this migration specifically): ${migrationCreated.length}`);
  const otherNew = newlyCreated.filter((rp) => rp.createdBy !== "backlog_migration");
  console.log(`  Of which created by something ELSE since the backup (legitimate new activity -- a restore must NEVER touch these): ${otherNew.length}`);
  if (otherNew.length > 0) {
    console.log(`  Sample of other new activity (first 5):`);
    otherNew.slice(0, 5).forEach((rp) => console.log(`    - ${rp.id} createdBy="${rp.createdBy}" "${rp.brand} ${rp.name}"`));
  }

  console.log(`\n=== Supplier offers: modified since backup ===`);
  const suppliers = await getSuppliers();
  let totalOffersChecked = 0;
  let modifiedByMigration = 0;
  let modifiedByOtherActivity = 0;
  const migrationModifiedSamples: string[] = [];
  const otherModifiedSamples: string[] = [];

  for (const s of suppliers) {
    const backupSupplierData = backup.offersBySupplier[s.id];
    const currentOffers = await getCommittedOffers(s.id);
    for (const [offerKey, currentOffer] of Object.entries(currentOffers) as [string, SupplierOfferCurrent][]) {
      totalOffersChecked++;
      const backupOffer: SupplierOfferCurrent | undefined = backupSupplierData?.offers?.[offerKey];
      if (!backupOffer) continue; // brand-new offerKey since backup (a real new supplier row) -- not this migration's concern
      const changed =
        backupOffer.referenceProductId !== currentOffer.referenceProductId ||
        backupOffer.productId !== currentOffer.productId ||
        backupOffer.reviewStatus !== currentOffer.reviewStatus;
      if (!changed) continue;
      // Attribute to the migration specifically if the offer moved from
      // unresolved (needs_review/new_candidate, no ids) to resolved with
      // a referenceProductId/productId now set -- exactly this
      // migration's own signature of a change, distinct from a normal
      // re-upload (which would also update price/quantity/description,
      // not just review state).
      const looksLikeMigrationResolve =
        (backupOffer.reviewStatus === "needs_review" || backupOffer.reviewStatus === "new_candidate") &&
        !backupOffer.referenceProductId &&
        !backupOffer.productId &&
        (currentOffer.referenceProductId || currentOffer.productId) &&
        backupOffer.price === currentOffer.price &&
        backupOffer.description === currentOffer.description;
      if (looksLikeMigrationResolve) {
        modifiedByMigration++;
        if (migrationModifiedSamples.length < 5) migrationModifiedSamples.push(`[${s.name}] ${offerKey}: referenceProductId ${backupOffer.referenceProductId}->${currentOffer.referenceProductId}, productId ${backupOffer.productId}->${currentOffer.productId}`);
      } else {
        modifiedByOtherActivity++;
        if (otherModifiedSamples.length < 5) otherModifiedSamples.push(`[${s.name}] ${offerKey}: reviewStatus ${backupOffer.reviewStatus}->${currentOffer.reviewStatus} (likely a normal re-upload, NOT this migration)`);
      }
    }
  }
  console.log(`Total current offers checked: ${totalOffersChecked}`);
  console.log(`Changed and attributable to THIS migration: ${modifiedByMigration}`);
  migrationModifiedSamples.forEach((s) => console.log(`  ${s}`));
  console.log(`Changed for OTHER reasons since backup (legitimate activity -- a restore must NEVER touch these): ${modifiedByOtherActivity}`);
  otherModifiedSamples.forEach((s) => console.log(`  ${s}`));

  console.log(`\n=== Restore plan this data supports (NOT executed by this script) ===`);
  console.log(`If a restore were needed, it would: (1) DELETE exactly the ${migrationCreated.length} reference products tagged createdBy="backlog_migration" plus their UPC/EAN/signature pointer keys and index membership, (2) revert exactly the ${modifiedByMigration} offer hash fields identified above to their backed-up values, (3) SREM exactly the reverse-index members corresponding to those same offers. Every other record — ${otherNew.length} other new reference products and ${modifiedByOtherActivity} other offer changes — would be left completely untouched.`);
}
main();
