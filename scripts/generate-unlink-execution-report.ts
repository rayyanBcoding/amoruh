// READ-ONLY. Final execution report for the 82 confirmed
// UNLINK-SUSPICIOUS-OFFER cases from the cross-fragrance mismatch audit
// (same detection logic as generate-cross-fragrance-report.ts, filtered
// to that recommended action). For each: whether the suspicious offer
// is CURRENTLY the displayed Best Price, what the product would show
// after unlinking (the next real best price among the remaining
// offers), and whether it would auto-create or remain unresolved.
// Nothing is unlinked, created, or modified.
import * as XLSX from "xlsx";
import path from "path";
import { getCommittedOffers, getAllReferenceProducts, getProductOfferComparison, getReferenceProductOfferComparison } from "../src/lib/pricing-db";
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

  console.log("Fetching all suppliers' current offers...");
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

  console.log(`Confirmed UNLINK cases: ${cases.length}`);

  const pool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));

  interface ReportRow {
    masterProductId: string;
    masterProductName: string;
    suspiciousOfferDescription: string;
    suspiciousSupplier: string;
    suspiciousUpc: string;
    suspiciousEan: string;
    masterUpc: string;
    masterEan: string;
    currentlyDisplayedBestPrice: string;
    isSuspiciousCurrentlyWinning: string;
    afterUnlinkingBestPrice: string;
    wouldAutoCreate: string;
    closestExisting: string;
  }
  const rows: ReportRow[] = [];

  let processed = 0;
  for (const c of cases) {
    processed++;
    if (processed % 20 === 0) console.log(`  ...${processed}/${cases.length}`);

    const masterProductName = c.rp ? `${c.rp.brand} ${c.rp.name}` : c.p ? `${c.p.brand} ${c.p.name}` : c.identity;
    const masterUpc = c.rp?.upc ?? c.p?.barcode ?? "";
    const masterEan = c.rp?.ean ?? c.p?.barcode ?? "";

    const comparison = c.isRealProduct ? await getProductOfferComparison(c.identity) : await getReferenceProductOfferComparison(c.identity);
    const currentBest = comparison.bestPrice;
    const suspiciousIsWinning = currentBest?.offerKey === c.suspicious.offerKey && currentBest?.supplierId === c.suspicious.supplierId;
    const currentlyDisplayed = currentBest ? `$${currentBest.priceUsd} (${currentBest.supplierName})${suspiciousIsWinning ? " <-- THE SUSPICIOUS OFFER" : ""}` : "No actionable offer currently shown";

    // Simulate removing the suspicious offer from the actionable set.
    const remaining = comparison.actionable.filter((r) => !(r.offerKey === c.suspicious.offerKey && r.supplierId === c.suspicious.supplierId));
    const afterUnlink = remaining.length > 0 ? `$${remaining[0].priceUsd} (${remaining[0].supplierName})` : "No actionable offer would remain";

    const plausibleUpc = isPlausibleBarcode(c.suspicious.upc.trim().toUpperCase()) ? c.suspicious.upc.trim() : "";
    const plausibleEan = isPlausibleBarcode(c.suspicious.ean.trim().toUpperCase()) ? c.suspicious.ean.trim() : "";
    const attrs = extractAttributes(`${c.suspicious.brandField} ${c.suspicious.description}`, c.suspicious.effectiveBrand);
    const eligibility = checkAutoCreateEligibility(attrs, Boolean(plausibleUpc || plausibleEan));
    const wouldAutoCreate = eligibility.eligible ? "YES -- eligible to auto-create as its own new Master Product" : `NO -- ${eligibility.reason} (would sit as needs_review/new_candidate, searchable, not lost)`;

    const fresh = matchSupplierRow(
      { offerKey: c.suspicious.offerKey, supplierSku: c.suspicious.offerKey, description: c.suspicious.description, brand: c.suspicious.brandField, upc: c.suspicious.upc, ean: c.suspicious.ean },
      products,
      [],
      referenceProducts,
      pool
    );
    const candId = fresh.candidateReferenceProductId ?? fresh.candidateProductId ?? fresh.referenceProductId ?? fresh.productId;
    let closestExisting = "None found -- would remain new_candidate / genuinely new";
    if (candId && candId !== c.identity) {
      const rp2 = referenceProductById.get(candId);
      const p2 = productById.get(candId);
      closestExisting = rp2 ? `${rp2.brand} ${rp2.name} (${candId})` : p2 ? `${p2.brand} ${p2.name} (${candId})` : candId;
    }

    rows.push({
      masterProductId: c.identity,
      masterProductName,
      suspiciousOfferDescription: c.suspicious.description,
      suspiciousSupplier: c.suspicious.supplierName,
      suspiciousUpc: c.suspicious.upc,
      suspiciousEan: c.suspicious.ean,
      masterUpc,
      masterEan,
      currentlyDisplayedBestPrice: currentlyDisplayed,
      isSuspiciousCurrentlyWinning: suspiciousIsWinning ? "YES -- currently showing the wrong price" : "No -- a correct offer already wins today",
      afterUnlinkingBestPrice: afterUnlink,
      wouldAutoCreate,
      closestExisting,
    });
  }

  const wb = XLSX.utils.book_new();
  const data = rows.map((r, i) => ({
    "#": i + 2,
    "Master Product ID": r.masterProductId,
    "Master Product": r.masterProductName,
    "Master Product UPC": r.masterUpc,
    "Master Product EAN": r.masterEan,
    "Suspicious Offer Supplier": r.suspiciousSupplier,
    "Suspicious Offer Description": r.suspiciousOfferDescription,
    "Suspicious Offer UPC": r.suspiciousUpc,
    "Suspicious Offer EAN": r.suspiciousEan,
    "Currently Displayed Best Price": r.currentlyDisplayedBestPrice,
    "Is Suspicious Offer Currently Winning?": r.isSuspiciousCurrentlyWinning,
    "Best Price After Unlinking": r.afterUnlinkingBestPrice,
    "Would Auto-Create New Master Product?": r.wouldAutoCreate,
    "Closest Existing Master Product": r.closestExisting,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "UNLINK EXECUTION PLAN");

  const currentlyWrongCount = rows.filter((r) => r.isSuspiciousCurrentlyWinning.startsWith("YES")).length;
  const summaryData = [
    { Metric: "Total confirmed UNLINK cases", Value: rows.length },
    { Metric: "Currently displaying the WRONG (suspicious) price", Value: currentlyWrongCount },
    { Metric: "Already displaying the correct price today (offer just needs proper separation)", Value: rows.length - currentlyWrongCount },
    { Metric: "Would auto-create a new Master Product if unlinked", Value: rows.filter((r) => r.wouldAutoCreate.startsWith("YES")).length },
    { Metric: "Would remain unresolved (needs_review/new_candidate) if unlinked", Value: rows.filter((r) => r.wouldAutoCreate.startsWith("NO")).length },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryData), "SUMMARY");

  const outPath = path.resolve(__dirname, "..", "backups", `unlink-execution-report-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`);
  XLSX.writeFile(wb, outPath);
  console.log(`\nReport written to: ${outPath}`);
  console.log(`\n=== Summary ===`);
  for (const s of summaryData) console.log(`${s.Metric}: ${s.Value}`);
}
main();
