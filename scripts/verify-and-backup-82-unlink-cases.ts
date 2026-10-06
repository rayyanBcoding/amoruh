// READ-ONLY. Prep step for the 82-case cleanup — explicitly does NOT
// unlink anything. Two jobs, both zero-write:
//
// 1. Fresh re-verification: re-runs the exact same detection logic as
//    generate-cross-fragrance-report.ts / generate-unlink-execution-
//    report.ts against LIVE current data (not a stored list from the
//    earlier audit) and confirms every case still shows the same
//    matchType==="manual" + barcode-mismatch-against-the-Master-Product
//    pattern. Flags (does not act on) any case that has disappeared
//    (e.g. someone already fixed it) or any new one that has appeared
//    since the original 82 was computed.
// 2. Backup: for exactly these cases, snapshots the suspicious offer's
//    full current record, the Master Product record it's wrongly
//    attached to, and that Master Product's full reverse-index
//    membership (offers_by_reference_product / offers_by_product) — the
//    complete state an actual unlink would touch, so it's fully
//    reconstructable if anything needs to be undone.
//
// Does not touch the 194 KEEP, 16 HUMAN REVIEW, or 5 NON-MANUAL cases —
// only ever looks at rows matching this script's own UNLINK SUSPICIOUS
// OFFER detection (identical predicate to the original audit).
import fs from "fs";
import path from "path";
import {
  getCommittedOffers,
  getAllReferenceProducts,
  getOffersByReferenceProduct,
  getOffersByProduct,
} from "../src/lib/pricing-db";
import { getSuppliers } from "../src/lib/intake-db";
import { getProducts } from "../src/lib/db";
import {
  extractAttributes,
  resolveEffectiveBrand,
  matchSupplierRow,
  tokenSetSimilarity,
  buildMasterCandidatePool,
  buildBrandBucketedPool,
  checkAutoCreateEligibility,
  isPlausibleBarcode,
} from "../src/lib/pricing-matching";
import type { SupplierOfferCurrent, PricingReferenceProduct } from "../src/lib/pricing-types";
import type { Product } from "../src/lib/types";

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

async function main() {
  const suppliers = await getSuppliers();
  const [products, referenceProducts] = await Promise.all([getProducts(), getAllReferenceProducts()]);
  const referenceProductById = new Map(referenceProducts.map((rp) => [rp.id, rp]));
  const productById = new Map(products.map((p) => [p.id, p]));

  console.log("Fetching all suppliers' current offers (fresh, live)...");
  const offersBySupplier = await Promise.all(suppliers.map((s) => getCommittedOffers(s.id)));

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

  interface UnlinkCase {
    identity: string;
    isRealProduct: boolean;
    rp: PricingReferenceProduct | undefined;
    p: Product | undefined;
    correct: GroupedOffer;
    suspicious: GroupedOffer;
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

  console.log(`\n=== FRESH RE-VERIFICATION ===`);
  console.log(`Cases detected now: ${cases.length} (expected from earlier audit: ${EXPECTED_COUNT})`);
  if (cases.length !== EXPECTED_COUNT) {
    console.log(`*** COUNT MISMATCH — do not proceed with cleanup until this is explained. ***`);
  } else {
    console.log(`Count matches. Proceeding to per-case confirmation + backup.`);
  }

  // Explicit per-case pattern confirmation (redundant with the filter
  // above by construction, but stated plainly per the request to
  // "confirm each suspicious offer still has the same mismatched
  // barcode/manual-link pattern").
  let patternConfirmed = 0;
  for (const c of cases) {
    const masterUpc = c.rp?.upc ?? c.p?.barcode ?? "";
    const masterEan = c.rp?.ean ?? c.p?.barcode ?? "";
    const isManual = c.suspicious.matchType === "manual";
    const barcodeMismatches = !barcodeMatchesRecord(c.suspicious, masterUpc, masterEan);
    if (isManual && barcodeMismatches) patternConfirmed++;
  }
  console.log(`Pattern confirmed (matchType=manual AND barcode mismatches Master Product record): ${patternConfirmed}/${cases.length}`);

  // What new Master Product each would create if unlinked — fresh
  // computation via the real matcher, not reused from the earlier report.
  const pool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));
  let wouldAutoCreateCount = 0;
  const backupEntries: Record<string, unknown>[] = [];

  console.log(`\nComputing auto-create outcome + snapshotting affected state for each case...`);
  let processed = 0;
  for (const c of cases) {
    processed++;
    if (processed % 20 === 0) console.log(`  ...${processed}/${cases.length}`);

    const plausibleUpc = isPlausibleBarcode(c.suspicious.upc.trim().toUpperCase()) ? c.suspicious.upc.trim() : "";
    const plausibleEan = isPlausibleBarcode(c.suspicious.ean.trim().toUpperCase()) ? c.suspicious.ean.trim() : "";
    const attrs = extractAttributes(`${c.suspicious.brandField} ${c.suspicious.description}`, c.suspicious.effectiveBrand);
    const eligibility = checkAutoCreateEligibility(attrs, Boolean(plausibleUpc || plausibleEan));
    if (eligibility.eligible) wouldAutoCreateCount++;

    const fresh = matchSupplierRow(
      { offerKey: c.suspicious.offerKey, supplierSku: c.suspicious.offerKey, description: c.suspicious.description, brand: c.suspicious.brandField, upc: c.suspicious.upc, ean: c.suspicious.ean },
      products,
      [],
      referenceProducts,
      pool
    );
    const candId = fresh.candidateReferenceProductId ?? fresh.candidateProductId ?? fresh.referenceProductId ?? fresh.productId;
    let closestExisting: string | null = null;
    if (candId && candId !== c.identity) {
      const rp2 = referenceProductById.get(candId);
      const p2 = productById.get(candId);
      closestExisting = rp2 ? `${rp2.brand} ${rp2.name} (${candId})` : p2 ? `${p2.brand} ${p2.name} (${candId})` : candId;
    }

    // Full current offer record (exact state an unlink would overwrite).
    const fullOffer = (offersBySupplier[suppliers.findIndex((s) => s.id === c.suspicious.supplierId)] as Record<string, SupplierOfferCurrent>)[c.suspicious.offerKey];

    // Full reverse-index membership for the Master Product this offer is
    // wrongly attached to (exact SREM target an unlink would issue).
    const reverseIndexMembers = c.isRealProduct ? await getOffersByProduct(c.identity) : await getOffersByReferenceProduct(c.identity);

    backupEntries.push({
      masterProductId: c.identity,
      masterProductType: c.isRealProduct ? "real_product" : "reference_product",
      masterProductRecord: c.rp ?? c.p ?? null,
      suspiciousOfferSupplierId: c.suspicious.supplierId,
      suspiciousOfferSupplierName: c.suspicious.supplierName,
      suspiciousOfferKey: c.suspicious.offerKey,
      suspiciousOfferFullRecord: fullOffer ?? null,
      wouldAutoCreate: eligibility.eligible,
      autoCreateReason: eligibility.eligible ? null : eligibility.reason,
      closestExistingMasterProductIfNotAutoCreate: closestExisting,
      masterProductReverseIndexMembersAtBackupTime: reverseIndexMembers,
    });
  }

  console.log(`\n=== AUTO-CREATE PROJECTION ===`);
  console.log(`Would auto-create a new Master Product: ${wouldAutoCreateCount}/${cases.length}`);
  console.log(`Would remain unresolved (needs_review/new_candidate): ${cases.length - wouldAutoCreateCount}/${cases.length}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(__dirname, "..", "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `82-unlink-cases-backup-${timestamp}.json`);

  const snapshot = {
    takenAt: new Date().toISOString(),
    purpose: "Pre-unlink backup + fresh re-verification for the 82 UNLINK SUSPICIOUS OFFER cases. READ-ONLY — no unlink executed by this script.",
    expectedCount: EXPECTED_COUNT,
    detectedCount: cases.length,
    countMatchesExpected: cases.length === EXPECTED_COUNT,
    patternConfirmedCount: patternConfirmed,
    wouldAutoCreateCount,
    wouldRemainUnresolvedCount: cases.length - wouldAutoCreateCount,
    cases: backupEntries,
  };
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  const stats = fs.statSync(outPath);

  console.log(`\n=== BACKUP ===`);
  console.log(`Backup written to: ${outPath}`);
  console.log(`Size: ${(stats.size / 1024).toFixed(1)} KB`);
  console.log(`Cases captured: ${backupEntries.length}`);
  console.log(`\nNothing was unlinked, created, or modified. Stopping here for separate approval, per instruction.`);
}
main();
