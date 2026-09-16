// Two-stage backlog reprocessing migration for the missing-brand fix.
//   --dry-run (default): zero writes. Reports projected outcome for
//     every currently-unresolved offer across all suppliers, processed
//     SEQUENTIALLY with a growing in-memory candidate pool (mirroring
//     processSupplierUpload's own mutable in-import list) so a genuine
//     duplicate WITHIN this backlog (two different suppliers' rows for
//     the identical item, both still unresolved) is correctly counted
//     as one creation + one reuse, not two independent creations.
//   --execute --confirm-production: re-verifies fresh (never trusts
//     cached dry-run state) and performs the real writes via the exact
//     same getOrCreateReferenceProductByIdentity primitive the live
//     upload path uses — no bespoke logic.
//
// NOT yet run in --execute mode. Per the governing task: STOP for
// explicit approval before any production write.

import { getSuppliers } from "../src/lib/intake-db";
import { getCommittedOffers, getAllReferenceProducts } from "../src/lib/pricing-db";
import { getProducts } from "../src/lib/db";
import {
  extractAttributes,
  checkAutoCreateEligibility,
  isValidProductRow,
  matchSupplierRow,
  resolveEffectiveBrand,
  computeIdentitySignature,
  isPlausibleBarcode,
} from "../src/lib/pricing-matching";
import type { PricingReferenceProduct } from "../src/lib/pricing-types";
import type { Product } from "../src/lib/types";

const EXECUTE = process.argv.includes("--execute");
const CONFIRMED = process.argv.includes("--confirm-production");

async function main() {
  if (EXECUTE && !CONFIRMED) {
    console.error("--execute requires --confirm-production. Refusing to run.");
    process.exit(1);
  }
  if (EXECUTE) {
    // Intentionally incomplete and refused: a real execute pass must
    // also update each SupplierOfferCurrent record's own
    // referenceProductId/reviewStatus (via the same commit path
    // processSupplierUpload uses) after creating/linking a Master
    // Product — not implemented here yet, and not to be run until that
    // is built AND the governing task's explicit approval is given.
    console.error("--execute is not yet implemented/approved. This script currently only supports --dry-run.");
    process.exit(1);
  }

  const suppliers = await getSuppliers();
  const products: Product[] = await getProducts();
  // Mutable, growing pool — a row that resolves (links or creates)
  // during this pass is visible to every LATER row in this same batch,
  // exactly like processSupplierUpload's own in-import list.
  const pool: PricingReferenceProduct[] = await getAllReferenceProducts();

  let linkedToExisting = 0;
  let createdNew = 0;
  let dedupedWithinBacklog = 0;
  let stillAmbiguous = 0;
  let stillConflicting = 0;
  const conflictExamples: string[] = [];
  const creationLog: string[] = [];
  const linkLog: string[] = [];
  const dedupLog: string[] = [];

  for (const s of suppliers) {
    const offers = Object.values(await getCommittedOffers(s.id)).filter((o) => o.currentlyListed !== false);
    const unresolved = offers.filter(
      (o) => !o.productId && !o.referenceProductId && (o.reviewStatus === "needs_review" || o.reviewStatus === "new_candidate")
    );

    for (const o of unresolved) {
      const row = { offerKey: o.offerKey, supplierSku: o.supplierSku, description: o.description, brand: o.brand, upc: o.upc, ean: o.ean };
      if (!isValidProductRow(row)) continue;

      const freshMatch = matchSupplierRow(row, products, [], pool);

      if (freshMatch.reviewStatus === "auto_matched" && (freshMatch.productId || freshMatch.referenceProductId)) {
        linkedToExisting++;
        if (linkLog.length < 10) linkLog.push(`[${s.name}] "${o.description}" -> links to existing ${freshMatch.productId ?? freshMatch.referenceProductId}`);
        continue;
      }

      if (freshMatch.reviewStatus === "barcode_conflict") {
        stillConflicting++;
        if (conflictExamples.length < 10) conflictExamples.push(`[${s.name}] "${o.description}" -> barcode_conflict`);
        continue;
      }

      if (freshMatch.reviewStatus === "needs_review") {
        stillAmbiguous++;
        continue;
      }

      // new_candidate: check eligibility, then get-or-create (dry-run: simulated; execute: real).
      const effectiveBrand = resolveEffectiveBrand(row, products, pool);
      const attrs = extractAttributes(`${o.brand} ${o.description}`, effectiveBrand);
      const plausibleUpc = isPlausibleBarcode(o.upc.trim().toUpperCase()) ? o.upc.trim() : "";
      const plausibleEan = isPlausibleBarcode(o.ean.trim().toUpperCase()) ? o.ean.trim() : "";
      const eligibility = checkAutoCreateEligibility(attrs, Boolean(plausibleUpc || plausibleEan));

      if (!eligibility.eligible) {
        stillAmbiguous++;
        continue;
      }

      const signature = computeIdentitySignature(attrs);

      // Dry-run simulation only: replicate the same UPC/EAN/signature
      // lookup getOrCreateReferenceProductByIdentity would perform,
      // against the read-only pool, WITHOUT ever calling the real
      // write-capable primitive (EXECUTE mode exits above before this
      // point is ever reached).
      const byUpc = plausibleUpc ? pool.find((rp) => rp.upc && rp.upc.toUpperCase() === plausibleUpc.toUpperCase()) : undefined;
      const byEan = plausibleEan ? pool.find((rp) => rp.ean && rp.ean.toUpperCase() === plausibleEan.toUpperCase()) : undefined;
      const bySignature = pool.find((rp) => computeIdentitySignature(extractAttributes(`${rp.brand} ${rp.name} ${rp.description}`, rp.brand)) === signature);
      const hits = new Set([byUpc?.id, byEan?.id, bySignature?.id].filter(Boolean));

      if (hits.size > 1) {
        stillConflicting++;
        if (conflictExamples.length < 10) conflictExamples.push(`[${s.name}] "${o.description}" -> UPC/signature pointer disagreement`);
        continue;
      }
      if (hits.size === 1) {
        dedupedWithinBacklog++;
        if (dedupLog.length < 10) dedupLog.push(`[${s.name}] "${o.description}" -> would reuse a Master Product created earlier IN THIS SAME migration batch`);
        continue;
      }
      createdNew++;
      if (creationLog.length < 15) creationLog.push(`[${s.name}] "${o.description}" (brand="${effectiveBrand}") -> would create new Master Product`);
      // Simulate the write into the pool so later rows in this batch see it.
      pool.push({
        id: `dryrun_${o.offerKey}`,
        brand: effectiveBrand,
        name: o.description.trim(),
        description: o.description.trim(),
        sizeMl: attrs.sizeMl,
        concentration: attrs.concentration,
        isTester: attrs.isTester,
        isGiftSet: attrs.isGiftSet,
        isRefill: attrs.isRefill,
        productForm: attrs.productForm,
        upc: plausibleUpc,
        ean: plausibleEan,
        productId: null,
        createdAt: new Date().toISOString(),
        createdBy: "auto_import",
        creationMethod: "auto_import",
        createdFromSupplierId: s.id,
        createdFromUploadId: "backlog-migration-dryrun",
        createdFromOfferKey: o.offerKey,
      } as PricingReferenceProduct);
    }
  }

  console.log(`Mode: ${EXECUTE ? "EXECUTE (real writes)" : "DRY RUN (zero writes)"}\n`);
  console.log(`Linked to an EXISTING Master/real Product: ${linkedToExisting}`);
  console.log(`New Master Products created: ${createdNew}`);
  console.log(`Deduped against another row created earlier IN THIS batch: ${dedupedWithinBacklog}`);
  console.log(`Still genuinely ambiguous/incomplete (left in Match Review): ${stillAmbiguous}`);
  console.log(`Identity conflicts (UPC vs signature disagreement, or barcode_conflict): ${stillConflicting}`);
  console.log(`\nLink examples:`);
  linkLog.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nCreation examples:`);
  creationLog.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nIntra-batch dedup examples:`);
  dedupLog.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nConflict examples:`);
  conflictExamples.forEach((l) => console.log(`  - ${l}`));
}
main();
