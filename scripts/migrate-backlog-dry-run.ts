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
import { getCommittedOffers, getAllReferenceProducts, getOrCreateReferenceProductByIdentity, bulkUpdateOffers, type OffersByReferenceProductOp, type OffersByProductOp } from "../src/lib/pricing-db";
import { getProducts } from "../src/lib/db";
import {
  extractAttributes,
  checkAutoCreateEligibility,
  isUnsupportedMerchandise,
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
  const masterProductCountBefore = pool.length;
  let offersLinkedBefore = 0;

  let totalExamined = 0;
  let invalidRowCount = 0;
  // Reporting-only split of invalidRowCount (spec requires "unsupported
  // merchandise" as its own reconciling bucket) — never changes the
  // isValidProductRow pass/fail decision itself, just labels WHY a row
  // failed it for the dry-run report.
  let unsupportedMerchandiseCount = 0;
  let otherInvalidCount = 0;
  let linkedToExisting = 0;
  let createdNew = 0;
  let dedupedWithinBacklog = 0;
  let stillAmbiguous = 0;
  let stillConflicting = 0;
  // A row can be structurally eligible for auto-creation (checkAutoCreateEligibility
  // allows a real, verified barcode to anchor identity even with no
  // recognized brand — correct, standing behavior for the live upload
  // path). For THIS bulk backlog migration specifically, a human review
  // pass (per the migration proposal report) requires brand assignment
  // before creation — held back here, not created, until a later
  // targeted re-run once brands are confirmed. Tracked separately from
  // stillAmbiguous so the reconciliation report shows exactly how many
  // and why.
  let heldForBrandAssignment = 0;
  const invalidExamples: string[] = [];
  const conflictExamples: string[] = [];
  const brandHoldExamples: string[] = [];
  // Miami-specific slices of the same creation/link logs, required by
  // the spec to show its size-parsing fix's real effect separately.
  const miamiCreationLog: string[] = [];
  const miamiLinkLog: string[] = [];
  // Independent post-hoc audit trail for every proposed creation — used
  // below to verify, SEPARATELY from the incremental pool-based dedup
  // logic above, that none of the 3,000+ proposed creations collide
  // with each other on signature, UPC, or EAN.
  const createdIdentities: { signature: string; upc: string; ean: string; description: string; supplier: string }[] = [];
  const creationLog: string[] = [];
  const linkLog: string[] = [];
  const dedupLog: string[] = [];
  const spadesOutcomes: string[] = [];
  const haltaneOutcomes: string[] = [];

  for (const s of suppliers) {
    const offers = Object.values(await getCommittedOffers(s.id)).filter((o) => o.currentlyListed !== false);
    offersLinkedBefore += offers.filter((o) => o.productId || o.referenceProductId).length;
    const unresolved = offers.filter(
      (o) => !o.productId && !o.referenceProductId && (o.reviewStatus === "needs_review" || o.reviewStatus === "new_candidate")
    );

    // Accumulated for this supplier only, written ONCE via bulkUpdateOffers
    // after every row in this supplier is classified — never per-row.
    const offerUpdates: Record<string, SupplierOfferCurrent> = {};
    const refOps: OffersByReferenceProductOp[] = [];
    // A row can resolve directly to a real, carried Product with NO
    // linked reference product at all (matchSupplierRow's exact-UPC/EAN
    // real-Product branch explicitly returns referenceProductId: null in
    // that case) — offers_by_product is this identity's own reverse
    // index, exactly mirroring offers_by_reference_product below. Found
    // missing entirely during migration preflight: the original version
    // of this branch only ever pushed to refOps, silently reproducing
    // the historical "Wildcard problem" (offer linked, invisible via
    // reverse index) for this one specific match path.
    const productOps: OffersByProductOp[] = [];

    for (const o of unresolved) {
      totalExamined++;
      const row = { offerKey: o.offerKey, supplierSku: o.supplierSku, description: o.description, brand: o.brand, upc: o.upc, ean: o.ean };
      if (!isValidProductRow(row)) {
        invalidRowCount++;
        if (isUnsupportedMerchandise(o.description)) {
          unsupportedMerchandiseCount++;
        } else {
          otherInvalidCount++;
        }
        if (invalidExamples.length < 10) invalidExamples.push(`[${s.name}] "${o.description}"`);
        continue;
      }

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
        if (linkLog.length < 20) linkLog.push(`[${s.name}] "${o.description}" -> links to existing ${target}`);
        if (s.name.includes("Miami") && miamiLinkLog.length < 20) miamiLinkLog.push(`[${s.name}] "${o.description}" -> links to existing ${target}`);
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
          if (freshMatch.productId) productOps.push({ op: "SADD", productId: freshMatch.productId, member });
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

      if (!effectiveBrand || effectiveBrand.trim().toUpperCase() === "UNDEFINED") {
        heldForBrandAssignment++;
        track(`held for brand assignment (barcode=${plausibleUpc || plausibleEan || "none"})`);
        if (brandHoldExamples.length < 20) brandHoldExamples.push(`[${s.name}] "${o.description}"`);
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
          if (creationLog.length < 20) creationLog.push(`[${s.name}] "${o.description}" (brand="${effectiveBrand}") -> created ${resolvedId}`);
          if (s.name.includes("Miami") && miamiCreationLog.length < 20) miamiCreationLog.push(`[${s.name}] "${o.description}" (brand="${effectiveBrand}") -> created ${resolvedId}`);
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
        if (creationLog.length < 20) creationLog.push(`[${s.name}] "${o.description}" (brand="${effectiveBrand}") -> would create new Master Product`);
        if (s.name.includes("Miami") && miamiCreationLog.length < 20) miamiCreationLog.push(`[${s.name}] "${o.description}" (brand="${effectiveBrand}") -> would create new Master Product`);
        createdIdentities.push({ signature, upc: plausibleUpc, ean: plausibleEan, description: o.description, supplier: s.name });
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
      const result = await bulkUpdateOffers(s.id, offerUpdates, { offersByReferenceProductOps: refOps, offersByProductOps: productOps });
      if (!result.ok) {
        console.error(`\nSTOPPED — bulk write FAILED for supplier "${s.name}" (${s.id}): ${result.reason}`);
        console.error(`Rows already written for suppliers processed before this one are safe and complete.`);
        console.error(`Re-running with --execute --confirm-production will safely re-verify and resume — already-linked offers are skipped by the unresolved filter, and getOrCreateReferenceProductByIdentity is idempotent.`);
        process.exit(1);
      }
      console.log(`[${s.name}] wrote ${result.count} offer updates, ${refOps.length} reference-product reverse-index ops, ${productOps.length} real-product reverse-index ops.`);
    }
  }

  console.log(`\nMode: ${EXECUTE ? "EXECUTE (real writes)" : "DRY RUN (zero writes)"}\n`);
  console.log(`Total unresolved offers examined: ${totalExamined}`);
  console.log(`Invalid/non-product rows (excluded before classification): ${invalidRowCount}`);
  console.log(`  — of which unsupported merchandise (empty boxes/bags/sleeves/etc.): ${unsupportedMerchandiseCount}`);
  console.log(`  — of which other invalid/non-product (junk text, no product content): ${otherInvalidCount}`);
  console.log(`Linked to an EXISTING Master/real Product: ${linkedToExisting}`);
  console.log(`New Master Products created: ${createdNew}`);
  console.log(`Deduped against another row created earlier IN THIS batch: ${dedupedWithinBacklog}`);
  console.log(`Held for brand assignment (eligible via barcode alone, but NOT created until a human confirms the brand — see report): ${heldForBrandAssignment}`);
  console.log(`Still genuinely ambiguous/incomplete (left in Match Review): ${stillAmbiguous}`);
  console.log(`Identity conflicts (UPC vs signature disagreement, or barcode_conflict): ${stillConflicting}`);
  const reconciledTotal = invalidRowCount + linkedToExisting + createdNew + dedupedWithinBacklog + heldForBrandAssignment + stillAmbiguous + stillConflicting;
  console.log(`\nRECONCILIATION: ${totalExamined} examined = ${invalidRowCount} invalid + ${linkedToExisting} linked + ${createdNew} created + ${dedupedWithinBacklog} deduped + ${heldForBrandAssignment} held-for-brand + ${stillAmbiguous} ambiguous + ${stillConflicting} conflicts = ${reconciledTotal} -> ${totalExamined === reconciledTotal ? "MATCH" : "MISMATCH — INVESTIGATE"}`);
  console.log(`\nHeld-for-brand-assignment examples (up to 20):`);
  brandHoldExamples.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nInvalid/non-product examples:`);
  invalidExamples.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nLink examples:`);
  linkLog.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nCreation examples (up to 20):`);
  creationLog.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nMiami Trading Zone creation examples (up to 20):`);
  miamiCreationLog.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nMiami Trading Zone link examples (up to 20):`);
  miamiLinkLog.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nIntra-batch dedup examples:`);
  dedupLog.forEach((l) => console.log(`  - ${l}`));
  console.log(`\nConflict examples:`);
  conflictExamples.forEach((l) => console.log(`  - ${l}`));

  // Independent post-hoc duplicate audit — deliberately re-derived from
  // scratch here rather than trusting the incremental pool-based checks
  // above, which only ever compare a row against candidates seen SO
  // FAR. This groups every proposed creation by signature/UPC/EAN
  // regardless of processing order, to positively confirm none of them
  // collide with each other.
  console.log(`\n=== Projected before/after (${EXECUTE ? "ACTUAL" : "PROJECTED"}) ===`);
  console.log(`Master Products before: ${masterProductCountBefore}`);
  console.log(`Master Products after:  ${masterProductCountBefore + createdNew} (+${createdNew})`);
  console.log(`Supplier offers already linked (productId or referenceProductId set) before: ${offersLinkedBefore}`);
  console.log(`Supplier offers linked after: ${offersLinkedBefore + linkedToExisting + createdNew} (+${linkedToExisting + createdNew})`);

  console.log(`\n=== Independent duplicate audit of all ${createdIdentities.length} proposed creations ===`);
  const bySignature = new Map<string, typeof createdIdentities>();
  for (const c of createdIdentities) {
    if (!bySignature.has(c.signature)) bySignature.set(c.signature, []);
    bySignature.get(c.signature)!.push(c);
  }
  const signatureDupes = [...bySignature.values()].filter((group) => group.length > 1);
  console.log(`Signature collisions among proposed creations: ${signatureDupes.length}`);
  signatureDupes.forEach((group) => group.forEach((c) => console.log(`  DUP-SIG [${c.supplier}] "${c.description}"`)));

  const byUpc = new Map<string, typeof createdIdentities>();
  for (const c of createdIdentities) {
    if (!c.upc) continue;
    if (!byUpc.has(c.upc)) byUpc.set(c.upc, []);
    byUpc.get(c.upc)!.push(c);
  }
  const upcDupes = [...byUpc.values()].filter((group) => group.length > 1);
  console.log(`UPC collisions among proposed creations: ${upcDupes.length}`);
  upcDupes.forEach((group) => group.forEach((c) => console.log(`  DUP-UPC [${c.supplier}] "${c.description}" upc=${c.upc}`)));

  const byEan = new Map<string, typeof createdIdentities>();
  for (const c of createdIdentities) {
    if (!c.ean) continue;
    if (!byEan.has(c.ean)) byEan.set(c.ean, []);
    byEan.get(c.ean)!.push(c);
  }
  const eanDupes = [...byEan.values()].filter((group) => group.length > 1);
  console.log(`EAN collisions among proposed creations: ${eanDupes.length}`);
  eanDupes.forEach((group) => group.forEach((c) => console.log(`  DUP-EAN [${c.supplier}] "${c.description}" ean=${c.ean}`)));

  console.log(`\n=== Game of Spades (${spadesOutcomes.length} rows) ===`);
  spadesOutcomes.forEach((l) => console.log(`  - ${l}`));
  console.log(`\n=== Haltane (${haltaneOutcomes.length} rows) ===`);
  haltaneOutcomes.forEach((l) => console.log(`  - ${l}`));
}
main();
