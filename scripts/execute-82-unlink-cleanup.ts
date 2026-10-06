// PRODUCTION WRITE SCRIPT. Executes the approved 82-case cleanup:
// unlinks each confirmed UNLINK-SUSPICIOUS-OFFER case from the Master
// Product it was wrongly manually linked to, then runs it through the
// same safe creation path "Track for Pricing" uses (createReferenceProductForOffer)
// so it gets its own correct Master Product (or links to an existing one
// if an exact UPC/EAN match already exists — never a duplicate).
//
// Hard requirements enforced by this script:
//  - Only ever touches the 82 cases from the approved backup file. Never
//    touches the 194 KEEP / 16 HUMAN REVIEW / 5 NON-MANUAL cases.
//  - Re-verifies live data against the backup FIRST. Any drift in count
//    or identity -> STOPS before any write.
//  - Any error during execution -> STOPS immediately, reports exactly
//    how far it got. No automatic rollback (the backup + this script's
//    own report are the recovery path); does not paper over a failure.
//  - Never touches supplier history, generations, Inventory, POs, Sales,
//    Intake, or Go Live — only calls unlinkOfferReference/
//    createReferenceProductForOffer, both of which only ever write
//    SupplierOfferCurrent + PricingReferenceProduct + the
//    offers_by_reference_product reverse index.
import fs from "fs";
import path from "path";
import {
  getCommittedOffers,
  getAllReferenceProducts,
  getOffersByReferenceProduct,
  getOffersByProduct,
  getCurrentOffer,
  getReferenceProduct,
  getProductOfferComparison,
  getReferenceProductOfferComparison,
} from "../src/lib/pricing-db";
import { getSuppliers } from "../src/lib/intake-db";
import { getProducts } from "../src/lib/db";
import { unlinkOfferReference, createReferenceProductForOffer } from "../src/lib/pricing-reference-linking";
import { unlinkOffer } from "../src/lib/pricing-product-linking";
import {
  extractAttributes,
  resolveEffectiveBrand,
  tokenSetSimilarity,
} from "../src/lib/pricing-matching";
import type { SupplierOfferCurrent, PricingReferenceProduct } from "../src/lib/pricing-types";
import type { Product } from "../src/lib/types";

const BACKUP_PATH = path.resolve(__dirname, "..", "backups", "82-unlink-cases-backup-2026-09-24T20-29-05-482Z.json");
const EXPECTED_COUNT = 82;

interface GroupedOffer {
  supplierId: string;
  supplierName: string;
  offerKey: string;
  description: string;
  brandField: string;
  effectiveBrand: string;
  upc: string;
  ean: string;
  coreTokens: string[];
  sizeMl: number | null;
  concentration: string | null;
  matchType: string;
}
interface UnlinkCase {
  identity: string;
  isRealProduct: boolean;
  rp: PricingReferenceProduct | undefined;
  p: Product | undefined;
  correct: GroupedOffer;
  suspicious: GroupedOffer;
}

function caseKey(supplierId: string, offerKey: string) {
  return `${supplierId}::${offerKey}`;
}

async function detectLiveCases(): Promise<{ cases: UnlinkCase[]; offersBySupplier: Record<string, SupplierOfferCurrent>[]; suppliers: { id: string; name: string }[] }> {
  const suppliers = await getSuppliers();
  const [products, referenceProducts] = await Promise.all([getProducts(), getAllReferenceProducts()]);
  const referenceProductById = new Map(referenceProducts.map((rp) => [rp.id, rp]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const offersBySupplier = (await Promise.all(suppliers.map((s) => getCommittedOffers(s.id)))) as Record<string, SupplierOfferCurrent>[];

  const groups = new Map<string, GroupedOffer[]>();
  for (let i = 0; i < suppliers.length; i++) {
    for (const o of Object.values(offersBySupplier[i]) as SupplierOfferCurrent[]) {
      if (o.currentlyListed === false) continue;
      if (o.reviewStatus !== "auto_matched" && o.reviewStatus !== "confirmed") continue;
      const identity = o.productId ?? o.referenceProductId;
      if (!identity) continue;
      const effectiveBrand = resolveEffectiveBrand({ brand: o.brand, description: o.description }, products, referenceProducts);
      const attrs = extractAttributes(`${o.brand} ${o.description}`, effectiveBrand);
      const meaningfulTokens = attrs.coreNameTokens.filter((t) => !/^\d+(\.\d+)?$/.test(t));
      if (!groups.has(identity)) groups.set(identity, []);
      groups.get(identity)!.push({
        supplierId: suppliers[i].id,
        supplierName: suppliers[i].name,
        offerKey: o.offerKey,
        description: o.description,
        brandField: o.brand,
        effectiveBrand,
        upc: o.upc,
        ean: o.ean,
        coreTokens: meaningfulTokens,
        sizeMl: attrs.sizeMl,
        concentration: attrs.concentration,
        matchType: o.matchType,
      });
    }
  }

  function barcodeMatchesRecord(offer: GroupedOffer, upc: string, ean: string): boolean {
    return (Boolean(offer.upc) && (offer.upc === upc || offer.upc === ean)) || (Boolean(offer.ean) && (offer.ean === upc || offer.ean === ean));
  }

  const cases: UnlinkCase[] = [];
  for (const [identity, rows] of groups) {
    if (rows.length < 2) continue;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        if (a.effectiveBrand.toLowerCase() !== b.effectiveBrand.toLowerCase()) continue;
        if (a.sizeMl === null || b.sizeMl === null || a.sizeMl !== b.sizeMl) continue;
        if (!a.concentration || !b.concentration || a.concentration !== b.concentration) continue;
        const sim = tokenSetSimilarity(a.coreTokens, b.coreTokens);
        if (sim >= 0.3) continue;

        const rp = referenceProductById.get(identity);
        const p = productById.get(identity);
        const masterUpc = rp?.upc ?? p?.barcode ?? "";
        const masterEan = rp?.ean ?? p?.barcode ?? "";
        const aOk = barcodeMatchesRecord(a, masterUpc, masterEan);
        const bOk = barcodeMatchesRecord(b, masterUpc, masterEan);

        let correct: GroupedOffer | null = null;
        let suspicious: GroupedOffer | null = null;
        if (aOk && !bOk) {
          correct = a;
          suspicious = b;
        } else if (bOk && !aOk) {
          correct = b;
          suspicious = a;
        }
        if (correct && suspicious && suspicious.matchType === "manual") {
          cases.push({ identity, isRealProduct: Boolean(p), rp, p, correct, suspicious });
        }
      }
    }
  }
  return { cases, offersBySupplier, suppliers: suppliers.map((s) => ({ id: s.id, name: s.name })) };
}

async function main() {
  console.log("=== STEP 0: Backup file check ===");
  if (!fs.existsSync(BACKUP_PATH)) {
    console.error(`STOP: backup file not found at ${BACKUP_PATH}`);
    process.exit(1);
  }
  const backupRaw = fs.readFileSync(BACKUP_PATH, "utf8");
  const backup = JSON.parse(backupRaw) as { cases: { masterProductId: string; suspiciousOfferSupplierId: string; suspiciousOfferKey: string }[] };
  console.log(`Backup file OK: ${BACKUP_PATH}`);
  console.log(`Backup cases: ${backup.cases.length}`);
  if (backup.cases.length !== EXPECTED_COUNT) {
    console.error(`STOP: backup file itself does not contain ${EXPECTED_COUNT} cases (has ${backup.cases.length}). Refusing to proceed.`);
    process.exit(1);
  }

  console.log("\n=== STEP 1: Fresh drift check against live data ===");
  const { cases: liveCases } = await detectLiveCases();
  console.log(`Live cases detected now: ${liveCases.length}`);

  const backupKeys = new Set(backup.cases.map((c) => caseKey(c.suspiciousOfferSupplierId, c.suspiciousOfferKey)));
  const liveKeys = new Set(liveCases.map((c) => caseKey(c.suspicious.supplierId, c.suspicious.offerKey)));

  const missingFromLive = [...backupKeys].filter((k) => !liveKeys.has(k));
  const newInLive = [...liveKeys].filter((k) => !backupKeys.has(k));
  const backupMasterById = new Map(backup.cases.map((c) => [caseKey(c.suspiciousOfferSupplierId, c.suspiciousOfferKey), c.masterProductId]));
  const masterIdentityDrift = liveCases.filter((c) => {
    const key = caseKey(c.suspicious.supplierId, c.suspicious.offerKey);
    const backedUpMaster = backupMasterById.get(key);
    return backedUpMaster !== undefined && backedUpMaster !== c.identity;
  });

  if (liveCases.length !== EXPECTED_COUNT || missingFromLive.length > 0 || newInLive.length > 0 || masterIdentityDrift.length > 0) {
    console.error(`\nSTOP: drift detected. No writes performed.`);
    console.error(`Expected count: ${EXPECTED_COUNT}, live count: ${liveCases.length}`);
    if (missingFromLive.length) console.error(`Cases in backup but no longer detected live (${missingFromLive.length}): ${missingFromLive.join(", ")}`);
    if (newInLive.length) console.error(`Cases detected live but not in backup (${newInLive.length}): ${newInLive.join(", ")}`);
    if (masterIdentityDrift.length) console.error(`Cases whose Master Product identity changed since backup (${masterIdentityDrift.length}): ${masterIdentityDrift.map((c) => caseKey(c.suspicious.supplierId, c.suspicious.offerKey)).join(", ")}`);
    process.exit(1);
  }
  console.log(`No drift. Exactly ${EXPECTED_COUNT} cases, identical identities to backup. Proceeding.`);

  console.log("\n=== STEP 2: Pre-execution price-impact snapshot ===");
  const preState: { case: UnlinkCase; wasWinning: boolean; bestPriceBefore: string }[] = [];
  for (const c of liveCases) {
    const comparison = c.isRealProduct ? await getProductOfferComparison(c.identity) : await getReferenceProductOfferComparison(c.identity);
    const wasWinning = comparison.bestPrice?.offerKey === c.suspicious.offerKey && comparison.bestPrice?.supplierId === c.suspicious.supplierId;
    preState.push({
      case: c,
      wasWinning,
      bestPriceBefore: comparison.bestPrice ? `$${comparison.bestPrice.priceUsd} (${comparison.bestPrice.supplierName})` : "No actionable offer",
    });
  }
  const wrongBeforeCount = preState.filter((s) => s.wasWinning).length;
  console.log(`Currently showing the wrong (suspicious) price: ${wrongBeforeCount}/${EXPECTED_COUNT}`);
  console.log(`Latent (correct price already showing, bad link still attached): ${EXPECTED_COUNT - wrongBeforeCount}/${EXPECTED_COUNT}`);

  console.log("\n=== STEP 3: EXECUTE — unlink ===");
  const unlinkResults: { key: string; ok: boolean; error?: string }[] = [];
  let haltedAtUnlink = false;
  for (const c of liveCases) {
    const key = caseKey(c.suspicious.supplierId, c.suspicious.offerKey);
    try {
      const result = c.isRealProduct
        ? await unlinkOffer(c.suspicious.supplierId, c.suspicious.offerKey)
        : await unlinkOfferReference(c.suspicious.supplierId, c.suspicious.offerKey);
      if (!result.ok) throw new Error(result.error ?? "unlink returned ok:false");

      const after = await getCurrentOffer(c.suspicious.supplierId, c.suspicious.offerKey);
      if (!after || after.referenceProductId || after.productId || after.matchType !== "unmatched" || after.reviewStatus !== "needs_review") {
        throw new Error(`post-unlink state check failed: ${JSON.stringify({ referenceProductId: after?.referenceProductId, productId: after?.productId, matchType: after?.matchType, reviewStatus: after?.reviewStatus })}`);
      }
      unlinkResults.push({ key, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`STOP: unlink failed for ${key}: ${message}`);
      unlinkResults.push({ key, ok: false, error: message });
      haltedAtUnlink = true;
      break;
    }
  }
  console.log(`Unlinked successfully: ${unlinkResults.filter((r) => r.ok).length}/${EXPECTED_COUNT}`);
  if (haltedAtUnlink) {
    console.error(`\nHALTED during unlink phase. ${unlinkResults.filter((r) => r.ok).length} of ${EXPECTED_COUNT} cases were unlinked before the error. Auto-create phase NOT started. See backup file for full recovery data.`);
    writeReport({ phase: "unlink", haltedAtUnlink: true, unlinkResults, createResults: [], preState, wrongBeforeCount });
    process.exit(1);
  }

  console.log("\n=== STEP 4: EXECUTE — safe auto-create / re-link ===");
  const createResults: { key: string; ok: boolean; newReferenceProductId?: string; linkedExisting?: boolean; upc?: string; ean?: string; error?: string }[] = [];
  let haltedAtCreate = false;
  for (const c of liveCases) {
    const key = caseKey(c.suspicious.supplierId, c.suspicious.offerKey);
    try {
      const result = await createReferenceProductForOffer(c.suspicious.supplierId, c.suspicious.offerKey, {
        brand: c.suspicious.brandField,
        name: c.suspicious.description,
      });
      if (!result.ok || !result.referenceProduct) throw new Error(result.error ?? "createReferenceProductForOffer returned ok:false");
      createResults.push({
        key,
        ok: true,
        newReferenceProductId: result.referenceProduct.id,
        linkedExisting: Boolean(result.linkedExisting),
        upc: result.referenceProduct.upc,
        ean: result.referenceProduct.ean,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`STOP: auto-create failed for ${key}: ${message}`);
      createResults.push({ key, ok: false, error: message });
      haltedAtCreate = true;
      break;
    }
  }
  console.log(`Re-resolved (created or linked existing): ${createResults.filter((r) => r.ok).length}/${EXPECTED_COUNT}`);
  console.log(`  New Master Products created: ${createResults.filter((r) => r.ok && !r.linkedExisting).length}`);
  console.log(`  Linked to an already-existing tracked item by exact UPC/EAN: ${createResults.filter((r) => r.ok && r.linkedExisting).length}`);
  if (haltedAtCreate) {
    console.error(`\nHALTED during auto-create phase. All ${EXPECTED_COUNT} offers were unlinked; ${createResults.filter((r) => r.ok).length} of ${EXPECTED_COUNT} were re-resolved before the error. Remaining offers are unlinked but NOT yet re-resolved (needs_review) — see backup file for recovery data.`);
    writeReport({ phase: "create", haltedAtUnlink: false, unlinkResults, createResults, preState, wrongBeforeCount });
    process.exit(1);
  }

  console.log("\n=== STEP 5: POST-VERIFICATION ===");

  // 5a. Duplicate check — any two NEWLY CREATED (not linked-existing)
  // reference products in this run sharing a plausible UPC/EAN would be
  // an actual duplicate-creation bug (createReferenceProductForOffer's
  // own dedup should prevent this by construction; verify it held).
  const newlyCreated = createResults.filter((r) => r.ok && !r.linkedExisting);
  const seenBarcodes = new Map<string, string>();
  const duplicates: string[] = [];
  for (const r of newlyCreated) {
    for (const bc of [r.upc, r.ean]) {
      if (!bc) continue;
      if (seenBarcodes.has(bc) && seenBarcodes.get(bc) !== r.key) {
        duplicates.push(`${bc}: ${seenBarcodes.get(bc)} vs ${r.key}`);
      } else {
        seenBarcodes.set(bc, r.key);
      }
    }
  }
  console.log(`Duplicate-barcode collisions among newly created Master Products: ${duplicates.length}${duplicates.length ? " -- " + duplicates.join("; ") : " (none)"}`);

  // 5b. Reverse-index correctness for every touched pair.
  let reverseIndexOk = 0;
  const reverseIndexProblems: string[] = [];
  for (let i = 0; i < liveCases.length; i++) {
    const c = liveCases[i];
    const cr = createResults[i];
    const key = caseKey(c.suspicious.supplierId, c.suspicious.offerKey);
    const member = { supplierId: c.suspicious.supplierId, offerKey: c.suspicious.offerKey };

    const oldMembers = c.isRealProduct ? await getOffersByProduct(c.identity) : await getOffersByReferenceProduct(c.identity);
    const stillInOld = oldMembers.some((m) => m.supplierId === member.supplierId && m.offerKey === member.offerKey);
    if (stillInOld) reverseIndexProblems.push(`${key}: still a member of the OLD Master Product's reverse index (${c.identity})`);

    if (cr.newReferenceProductId) {
      const newMembers = await getOffersByReferenceProduct(cr.newReferenceProductId);
      const inNew = newMembers.some((m) => m.supplierId === member.supplierId && m.offerKey === member.offerKey);
      if (!inNew) reverseIndexProblems.push(`${key}: NOT a member of its new Master Product's reverse index (${cr.newReferenceProductId})`);
      else if (!stillInOld) reverseIndexOk++;
    }
  }
  console.log(`Reverse indexes correct: ${reverseIndexOk}/${EXPECTED_COUNT}${reverseIndexProblems.length ? "\n  Problems:\n  " + reverseIndexProblems.join("\n  ") : ""}`);

  // 5c. Price-impact resolution: the previously-wrong ones must no
  // longer show the suspicious offer as best price; the previously-
  // latent ones must no longer carry the offer at all.
  let wrongNowFixed = 0;
  let latentNowClean = 0;
  const priceProblems: string[] = [];
  for (const s of preState) {
    const c = s.case;
    const comparison = c.isRealProduct ? await getProductOfferComparison(c.identity) : await getReferenceProductOfferComparison(c.identity);
    const stillCarriesSuspicious =
      comparison.actionable.some((r) => r.offerKey === c.suspicious.offerKey && r.supplierId === c.suspicious.supplierId) ||
      comparison.nonActionable.some((r) => r.offerKey === c.suspicious.offerKey && r.supplierId === c.suspicious.supplierId);
    const bestPriceAfter = comparison.bestPrice ? `$${comparison.bestPrice.priceUsd} (${comparison.bestPrice.supplierName})` : "No actionable offer";

    if (s.wasWinning) {
      if (!stillCarriesSuspicious && comparison.bestPrice?.offerKey !== c.suspicious.offerKey) wrongNowFixed++;
      else priceProblems.push(`${caseKey(c.suspicious.supplierId, c.suspicious.offerKey)}: was wrong-price-winning, still shows it after cleanup (before: ${s.bestPriceBefore}, after: ${bestPriceAfter})`);
    } else {
      if (!stillCarriesSuspicious) latentNowClean++;
      else priceProblems.push(`${caseKey(c.suspicious.supplierId, c.suspicious.offerKey)}: latent bad link still present after cleanup`);
    }
  }
  console.log(`Previously-wrong products now fixed: ${wrongNowFixed}/${wrongBeforeCount}`);
  console.log(`Previously-latent products now clean: ${latentNowClean}/${EXPECTED_COUNT - wrongBeforeCount}`);
  if (priceProblems.length) console.log(`  Problems:\n  ${priceProblems.join("\n  ")}`);

  console.log("\n=== STEP 6: Writing post-execution report ===");
  const summary = {
    unlinkedCount: unlinkResults.filter((r) => r.ok).length,
    reResolvedCount: createResults.filter((r) => r.ok).length,
    newMasterProductsCreated: newlyCreated.length,
    linkedToExistingByBarcode: createResults.filter((r) => r.ok && r.linkedExisting).length,
    duplicateBarcodeCollisions: duplicates.length,
    reverseIndexOkCount: reverseIndexOk,
    reverseIndexProblemCount: reverseIndexProblems.length,
    wrongBeforeCount,
    wrongNowFixed,
    latentBeforeCount: EXPECTED_COUNT - wrongBeforeCount,
    latentNowClean,
    priceProblemCount: priceProblems.length,
  };
  writeReport({ phase: "complete", haltedAtUnlink: false, unlinkResults, createResults, preState, wrongBeforeCount, summary });

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    summary.duplicateBarcodeCollisions === 0 && summary.reverseIndexProblemCount === 0 && summary.priceProblemCount === 0 && summary.unlinkedCount === EXPECTED_COUNT && summary.reResolvedCount === EXPECTED_COUNT
      ? "\nAll checks passed cleanly."
      : "\n*** ONE OR MORE CHECKS DID NOT PASS CLEANLY — see problems listed above. ***"
  );
}

function writeReport(data: unknown) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(__dirname, "..", "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `82-unlink-cleanup-execution-report-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ takenAt: new Date().toISOString(), ...( data as object) }, null, 2));
  console.log(`Report written to: ${outPath}`);
}

main().catch((err) => {
  console.error("UNEXPECTED ERROR:", err);
  process.exit(1);
});
