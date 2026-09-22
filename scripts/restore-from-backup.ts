// Targeted, selective restore from a pre-migration backup. By default
// (no --execute) this is a pure report — identical identification logic
// to recovery-diff.ts, safe to run any number of times. Only with
// --execute --confirm-restore does it perform real writes, and even
// then ONLY touches records it can positively attribute to the
// migration being undone: reference products tagged
// createdBy="backlog_migration" that don't exist in the backup, and
// offers whose fields changed in exactly the shape a migration resolve
// produces (unresolved -> resolved, same price/description). Every
// other record -- any other new activity, any other offer change -- is
// left completely untouched. Never resets or wipes anything in bulk.
//
// Usage:
//   npx tsx --env-file=.env.development.local scripts/restore-from-backup.ts <backup.json>                          (report only)
//   npx tsx --env-file=.env.development.local scripts/restore-from-backup.ts <backup.json> --execute --confirm-restore  (real writes)
import fs from "fs";
import { getSuppliers } from "../src/lib/intake-db";
import { getCommittedOffers, bulkUpdateOffers, deleteReferenceProductAndPointers } from "../src/lib/pricing-db";
import { computeIdentitySignature, extractReferenceProductAttributes } from "../src/lib/pricing-matching";
import type { PricingReferenceProduct, SupplierOfferCurrent } from "../src/lib/pricing-types";

const EXECUTE = process.argv.includes("--execute");
const CONFIRMED = process.argv.includes("--confirm-restore");

async function main() {
  if (EXECUTE && !CONFIRMED) {
    console.error("--execute requires --confirm-restore. Refusing to run.");
    process.exit(1);
  }
  const backupPath = process.argv.find((a) => a.endsWith(".json"));
  if (!backupPath) {
    console.error("Usage: npx tsx scripts/restore-from-backup.ts <backup.json> [--execute --confirm-restore]");
    process.exit(1);
  }
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  const backupRefById = new Map<string, PricingReferenceProduct>(backup.referenceProducts.map((rp: PricingReferenceProduct) => [rp.id, rp]));

  console.log(`Mode: ${EXECUTE ? "EXECUTE (real writes)" : "REPORT ONLY (zero writes)"}`);
  console.log(`Backup taken at: ${backup.takenAt}`);

  const { getAllReferenceProducts } = await import("../src/lib/pricing-db");
  const currentRefs = await getAllReferenceProducts();
  const toDelete = currentRefs.filter((rp) => !backupRefById.has(rp.id) && rp.createdBy === "backlog_migration");
  console.log(`\nReference products to delete (createdBy="backlog_migration", not in backup): ${toDelete.length}`);

  const suppliers = await getSuppliers();
  const offerReverts: { supplierId: string; supplierName: string; offerKey: string; backedUp: SupplierOfferCurrent }[] = [];
  for (const s of suppliers) {
    const backupSupplierData = backup.offersBySupplier[s.id];
    if (!backupSupplierData) continue;
    const currentOffers = await getCommittedOffers(s.id);
    for (const [offerKey, currentOffer] of Object.entries(currentOffers) as [string, SupplierOfferCurrent][]) {
      const backedUp: SupplierOfferCurrent | undefined = backupSupplierData.offers?.[offerKey];
      if (!backedUp) continue;
      const changed = backedUp.referenceProductId !== currentOffer.referenceProductId || backedUp.productId !== currentOffer.productId || backedUp.reviewStatus !== currentOffer.reviewStatus;
      if (!changed) continue;
      const looksLikeMigrationResolve =
        (backedUp.reviewStatus === "needs_review" || backedUp.reviewStatus === "new_candidate") &&
        !backedUp.referenceProductId && !backedUp.productId &&
        (currentOffer.referenceProductId || currentOffer.productId) &&
        backedUp.price === currentOffer.price && backedUp.description === currentOffer.description;
      if (looksLikeMigrationResolve) offerReverts.push({ supplierId: s.id, supplierName: s.name, offerKey, backedUp });
    }
  }
  console.log(`Offers to revert to their backed-up (unresolved) state: ${offerReverts.length}`);

  if (!EXECUTE) {
    console.log("\nReport only -- no writes performed. Re-run with --execute --confirm-restore to actually perform this restore.");
    toDelete.slice(0, 20).forEach((rp) => console.log(`  WOULD DELETE: ${rp.id} "${rp.brand} ${rp.name}"`));
    offerReverts.slice(0, 20).forEach((r) => console.log(`  WOULD REVERT: [${r.supplierName}] ${r.offerKey} -> referenceProductId=${r.backedUp.referenceProductId} productId=${r.backedUp.productId} reviewStatus=${r.backedUp.reviewStatus}`));
    return;
  }

  console.log("\n=== EXECUTING RESTORE ===");
  let deletedCount = 0;
  for (const rp of toDelete) {
    const attrs = extractReferenceProductAttributes(rp);
    const signature = computeIdentitySignature(attrs);
    const result = await deleteReferenceProductAndPointers(rp.id, signature);
    console.log(`  ${result.deletedRecord ? "DELETED" : "SKIPPED (already gone)"}: ${rp.id} "${rp.brand} ${rp.name}"`);
    if (result.deletedRecord) deletedCount++;
  }

  let revertedCount = 0;
  const bySupplier = new Map<string, typeof offerReverts>();
  for (const r of offerReverts) {
    if (!bySupplier.has(r.supplierId)) bySupplier.set(r.supplierId, []);
    bySupplier.get(r.supplierId)!.push(r);
  }
  for (const [supplierId, reverts] of bySupplier) {
    const updates: Record<string, SupplierOfferCurrent> = {};
    const refOps: { op: "SADD" | "SREM"; referenceProductId: string; member: string }[] = [];
    for (const r of reverts) {
      updates[r.offerKey] = r.backedUp;
      const current = (await getCommittedOffers(supplierId))[r.offerKey];
      if (current?.referenceProductId) refOps.push({ op: "SREM", referenceProductId: current.referenceProductId, member: `${supplierId}::${r.offerKey}` });
    }
    const result = await bulkUpdateOffers(supplierId, updates, { offersByReferenceProductOps: refOps });
    if (result.ok) {
      revertedCount += result.count;
      console.log(`  [${reverts[0].supplierName}] reverted ${result.count} offers, ${refOps.length} reverse-index removals`);
    } else {
      console.error(`  [${reverts[0].supplierName}] FAILED: ${result.reason}`);
    }
  }

  console.log(`\nRestore complete: ${deletedCount} reference products deleted, ${revertedCount} offers reverted.`);
}
main();
