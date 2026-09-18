// Two-stage backlog reprocessing migration.
//   --dry-run (default): zero writes. Reports projected outcome for
//     every currently-unresolved offer across all suppliers, processed
//     SEQUENTIALLY with a growing in-memory candidate pool (mirroring
//     processSupplierUpload's own mutable in-import list) so a genuine
//     duplicate WITHIN this backlog (two different suppliers' rows for
//     the identical item, both still unresolved) is correctly counted
//     as one creation + one reuse, not two independent creations.
//   --execute --confirm-production: re-verifies fresh (never trusts
//     cached dry-run state — every row is freshly matched/checked in
//     this same run) and performs the real writes via the exact same
//     getOrCreateReferenceProductByIdentity primitive the live upload
//     path uses (no bespoke creation logic), then persists each
//     resolved offer's own referenceProductId/reviewStatus/matchType
//     via bulkUpdateOffers — the same field-level primitive built for
//     the earlier 13,224-item backlog migration, chunked per supplier.
//     Writes are batched and applied ONCE per supplier, after that
//     supplier's rows are all classified, so a mid-run failure stops
//     the whole script (never silently continues to other suppliers)
//     and reports exactly where it stopped for a safe, targeted retry.
//
// Never touches rows staying genuinely ambiguous/conflicting — those
// are left completely untouched, still visible in Match Review exactly
// as before.

import { getSuppliers } from "../src/lib/intake-db";
import { getCommittedOffers, getAllReferenceProducts, getOrCreateReferenceProductByIdentity, bulkUpdateOffers, type OffersByReferenceProductOp } from "../src/lib/pricing-db";
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
import type { PricingReferenceProduct, SupplierOfferCurrent } from "../src/lib/pricing-types";
import type { Product } from "../src/lib/types";

const EXECUTE = process.argv.includes("--execute");
const CONFIRMED = process.argv.includes("--confirm-production");

async function main() {
  if (EXECUTE && !CONFIRMED) {
    console.error("--execute requires --confirm-production. Refusing to run.");
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
  const spadesOutcomes: string[] = [];
  const haltaneOutcomes: string[] = [];

  for (const s of suppliers) {
    const offers = Object.values(await getCommittedOffers(s.id)).filter((o) => o.currentlyListed !== false);
    const unresolved = offers.filter(
      (o) => !o.productId && !o.referenceProductId && (o.reviewStatus === "needs_review" || o.reviewStatus === "new_candidate")
    );

    // Accumulated for this supplier only, written ONCE via bulkUpdateOffers
    // after every row in this supplier is classified — never per-row.
    const offerUpdates: Record<string, SupplierOfferCurrent> = {};
    const refOps: OffersByReferenceProductOp[] = [];

    for (const o of unresolved) {
      const row = { offerKey: o.offerKey, supplierSku: o.supplierSku, description: o.description, brand: o.brand, upc: o.upc, ean: o.ean };
      if (!isValidProductRow(row)) continue;

      const desc = o.description.toUpperCase();
      const isSpades = desc.includes("SPADE");
      const isHaltane = desc.includes("HALTANE");
      const track = (outcome: string) => {
        if (isSpades) spadesOutcomes.push(`[${s.name}] "${o.description}" -> ${outcome}`);
        if (isHaltane) haltaneOutcomes.push(`[${s.name}] "${o.description}" -> ${outcome}`);
      };

      const freshMatch = matchSupplierRow(row, products, [], pool);

      if (freshMatch.reviewStatus === "auto_matched" && (freshMatch.productId || freshMatch.referenceProductId)) {
        linkedToExisting++;
        const target = freshMatch.productId ?? freshMatch.referenceProductId;
        track(`links to existing ${target}`);
        if (linkLog.length < 10) linkLog.push(`[${s.name}] "${o.description}" -> links to existing ${target}`);
        if (EXECUTE) {
          const member = `${s.id}::${o.offerKey}`;
          offerUpdates[o.offerKey] = {
            ...o,
            productId: freshMatch.productId,
            referenceProductId: freshMatch.referenceProductId,
            candidateProductId: freshMatch.productId,
            candidateReferenceProductId: freshMatch.productId ? null : freshMatch.referenceProductId,
            matchType: freshMatch.matchType,
            matchConfidence: freshMatch.matchConfidence,
            reviewStatus: "auto_matched",
            reviewRequestedAt: null,
          };
          if (freshMatch.referenceProductId) refOps.push({ op: "SADD", referenceProductId: freshMatch.referenceProductId, member });
        }
        continue;
      }

      if (freshMatch.reviewStatus === "barcode_conflict") {
        stillConflicting++;
        track("barcode_conflict");
        if (conflictExamples.length < 10) conflictExamples.push(`[${s.name}] "${o.description}" -> barcode_conflict`);
        continue;
      }

      if (freshMatch.reviewStatus === "needs_review") {
        stillAmbiguous++;
        track(`needs_review (candidate=${freshMatch.candidateReferenceProductId ?? freshMatch.candidateProductId ?? "none"})`);
        continue;
      }

      // new_candidate: check eligibility, then get-or-create.
      const effectiveBrand = resolveEffectiveBrand(row, products, pool);
      const attrs = extractAttributes(`${o.brand} ${o.description}`, effectiveBrand);
      const plausibleUpc = isPlausibleBarcode(o.upc.trim().toUpperCase()) ? o.upc.trim() : "";
      const plausibleEan = isPlausibleBarcode(o.ean.trim().toUpperCase()) ? o.ean.trim() : "";
      const eligibility = checkAutoCreateEligibility(attrs, Boolean(plausibleUpc || plausibleEan));

      if (!eligibility.eligible) {
        stillAmbiguous++;
        track(`ineligible: ${eligibility.reason}`);
        continue;
      }

      const signature = computeIdentitySignature(attrs);

      if (EXECUTE) {
        const result = await getOrCreateReferenceProductByIdentity(
          { upc: plausibleUpc, ean: plausibleEan, signature },
          {
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
            createdBy: "backlog_migration",
            creationMethod: "auto_import",
            createdFromSupplierId: s.id,
            createdFromUploadId: null,
            createdFromOfferKey: o.offerKey,
          }
        );

        if (result.status === "conflict") {
          stillConflicting++;
          track(`UPC/signature pointer disagreement (real conflict: ${result.ids.join(",")})`);
          if (conflictExamples.length < 10) conflictExamples.push(`[${s.name}] "${o.description}" -> UPC/signature pointer disagreement (${result.ids.join(",")})`);
          continue;
        }

        const resolvedId = result.id;
        if (result.status === "existing") {
          dedupedWithinBacklog++;
          track(`reused a Master Product created earlier in this batch (${resolvedId})`);
        } else {
          createdNew++;
          track(`created new Master Product (brand="${effectiveBrand}") -> ${resolvedId}`);
          if (creationLog.length < 15) creationLog.push(`[${s.name}] "${o.description}" (brand="${effectiveBrand}") -> created ${resolvedId}`);
          pool.push(result.product);
        }

        const member = `${s.id}::${o.offerKey}`;
        offerUpdates[o.offerKey] = {
          ...o,
          referenceProductId: resolvedId,
          candidateReferenceProductId: resolvedId,
          matchType: result.status === "created" ? "auto_created" : "structured",
          matchConfidence: 1,
          reviewStatus: "auto_matched",
          reviewRequestedAt: null,
        };
        refOps.push({ op: "SADD", referenceProductId: resolvedId, member });
      } else {
        // Dry-run simulation only: replicate the same UPC/EAN/signature
        // lookup getOrCreateReferenceProductByIdentity would perform,
        // against the read-only pool, WITHOUT ever calling the real
        // write-capable primitive.
        const byUpc = plausibleUpc ? pool.find((rp) => rp.upc && rp.upc.toUpperCase() === plausibleUpc.toUpperCase()) : undefined;
        const byEan = plausibleEan ? pool.find((rp) => rp.ean && rp.ean.toUpperCase() === plausibleEan.toUpperCase()) : undefined;
        const bySignature = pool.find((rp) => computeIdentitySignature(extractAttributes(`${rp.brand} ${rp.name} ${rp.description}`, rp.brand)) === signature);
        const hits = new Set([byUpc?.id, byEan?.id, bySignature?.id].filter(Boolean));

        if (hits.size > 1) {
          stillConflicting++;
          track("UPC/signature pointer disagreement");
          if (conflictExamples.length < 10) conflictExamples.push(`[${s.name}] "${o.description}" -> UPC/signature pointer disagreement`);
          continue;
        }
        if (hits.size === 1) {
          dedupedWithinBacklog++;
          track("would reuse a Master Product created earlier in this same migration batch");
          if (dedupLog.length < 10) dedupLog.push(`[${s.name}] "${o.description}" -> would reuse a Master Product created earlier IN THIS SAME migration batch`);
          continue;
        }
        createdNew++;
        track(`would create new Master Product (brand="${effectiveBrand}")`);
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

    if (EXECUTE && Object.keys(offerUpdates).length > 0) {
      const result = await bulkUpdateOffers(s.id, offerUpdates, { offersByReferenceProductOps: refOps });
      if (!result.ok) {
        console.error(`\nSTOPPED — bulk write FAILED for supplier "${s.name}" (${s.id}): ${result.reason}`);
        console.error(`Rows already written for suppliers processed before this one are safe and complete.`);
        console.error(`Re-running with --execute --confirm-production will safely re-verify and resume — already-linked offers are skipped by the unresolved filter, and getOrCreateReferenceProductByIdentity is idempotent.`);
        process.exit(1);
      }
      console.log(`[${s.name}] wrote ${result.count} offer updates, ${refOps.length} reverse-index ops.`);
    }
  }

  console.log(`\nMode: ${EXECUTE ? "EXECUTE (real writes)" : "DRY RUN (zero writes)"}\n`);
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

  console.log(`\n=== Game of Spades (${spadesOutcomes.length} rows) ===`);
  spadesOutcomes.forEach((l) => console.log(`  - ${l}`));
  console.log(`\n=== Haltane (${haltaneOutcomes.length} rows) ===`);
  haltaneOutcomes.forEach((l) => console.log(`  - ${l}`));
}
main();
