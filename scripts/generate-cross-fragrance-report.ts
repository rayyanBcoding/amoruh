// READ-ONLY. Generates the full spreadsheet of every flagged
// cross-fragrance mismatch pair (same detection logic as
// audit-cross-fragrance-mismatches.ts), with per-pair recommended
// actions, for human review. Does not unlink, create, or modify
// anything.
import * as XLSX from "xlsx";
import path from "path";
import { getCommittedOffers, getAllReferenceProducts } from "../src/lib/pricing-db";
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
  price: number;
  currency: string;
  quantity: number | null;
  coreTokens: string[];
  sizeMl: number | null;
  concentration: string | null;
  matchType: string;
  matchConfidence: number | null;
  reviewStatus: string;
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
        price: o.price,
        currency: o.currency,
        quantity: o.quantity,
        coreTokens: meaningfulTokens,
        sizeMl: attrs.sizeMl,
        concentration: attrs.concentration,
        matchType: o.matchType,
        matchConfidence: o.matchConfidence,
        reviewStatus: o.reviewStatus,
      });
    }
  }

  const CORE_NAME_SIMILARITY_FLOOR = 0.3;
  interface FlaggedPair {
    identity: string;
    isRealProduct: boolean;
    rp: PricingReferenceProduct | undefined;
    p: Product | undefined;
    a: GroupedOffer;
    b: GroupedOffer;
    similarity: number;
  }
  const flagged: FlaggedPair[] = [];

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
        if (sim < CORE_NAME_SIMILARITY_FLOOR) {
          flagged.push({
            identity,
            isRealProduct: productById.has(identity),
            rp: referenceProductById.get(identity),
            p: productById.get(identity),
            a,
            b,
            similarity: sim,
          });
        }
      }
    }
  }

  console.log(`Flagged pairs: ${flagged.length}`);

  // Build the matching pool ONCE for "would this auto-create / what's
  // the closest existing Master Product" checks below.
  console.log("Building candidate pool for closest-match / auto-create checks...");
  const pool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));

  function barcodeMatchesRecord(offer: GroupedOffer, upc: string, ean: string): boolean {
    return (Boolean(offer.upc) && (offer.upc === upc || offer.upc === ean)) || (Boolean(offer.ean) && (offer.ean === upc || offer.ean === ean));
  }

  interface ReportRow {
    masterProductId: string;
    masterProductName: string;
    masterProductUpc: string;
    masterProductEan: string;
    supplierA: string;
    descriptionA: string;
    upcA: string;
    eanA: string;
    priceA: string;
    qtyA: number | string;
    matchTypeA: string;
    reviewStatusA: string;
    confidenceA: number | string;
    supplierB: string;
    descriptionB: string;
    upcB: string;
    eanB: string;
    priceB: string;
    qtyB: number | string;
    matchTypeB: string;
    reviewStatusB: string;
    confidenceB: number | string;
    brandMatch: string;
    sizeMatch: string;
    concentrationMatch: string;
    coreNameOverlapPct: string;
    whyFlagged: string;
    correctOffer: string;
    suspiciousOffer: string;
    recommendedAction: string;
    wouldAutoCreateIfUnlinked: string;
    closestExistingMasterProduct: string;
    suspiciousOfferKey: string; // internal, for cross-referencing
    suspiciousMatchType: string; // internal, for the non-manual worksheet split
  }

  const rows: ReportRow[] = [];
  let processed = 0;
  for (const f of flagged) {
    processed++;
    if (processed % 50 === 0) console.log(`  ...${processed}/${flagged.length}`);

    const masterProductName = f.rp ? `${f.rp.brand} ${f.rp.name}` : f.p ? `${f.p.brand} ${f.p.name}` : f.identity;
    const masterUpc = f.rp?.upc ?? f.p?.barcode ?? "";
    const masterEan = f.rp?.ean ?? f.p?.barcode ?? "";

    const aBarcodeOk = barcodeMatchesRecord(f.a, masterUpc, masterEan);
    const bBarcodeOk = barcodeMatchesRecord(f.b, masterUpc, masterEan);

    let correctOffer = "";
    let suspicious: GroupedOffer | null = null;
    let correct: GroupedOffer | null = null;
    let recommendedAction = "NEEDS HUMAN REVIEW";

    if (aBarcodeOk && !bBarcodeOk) {
      correctOffer = "A";
      correct = f.a;
      suspicious = f.b;
    } else if (bBarcodeOk && !aBarcodeOk) {
      correctOffer = "B";
      correct = f.b;
      suspicious = f.a;
    } else if (aBarcodeOk && bBarcodeOk) {
      correctOffer = "Both barcode-verified";
      recommendedAction = "KEEP";
    } else {
      correctOffer = "Neither barcode-verified against Master Product";
    }

    if (suspicious && correct) {
      if (suspicious.matchType === "manual") {
        recommendedAction = "UNLINK SUSPICIOUS OFFER";
      } else {
        recommendedAction = "NEEDS HUMAN REVIEW";
      }
    }

    let wouldAutoCreate = "n/a";
    let closestExisting = "n/a";
    if (suspicious) {
      const plausibleUpc = isPlausibleBarcode(suspicious.upc.trim().toUpperCase()) ? suspicious.upc.trim() : "";
      const plausibleEan = isPlausibleBarcode(suspicious.ean.trim().toUpperCase()) ? suspicious.ean.trim() : "";
      const attrs = extractAttributes(`${suspicious.brandField} ${suspicious.description}`, suspicious.effectiveBrand);
      const eligibility = checkAutoCreateEligibility(attrs, Boolean(plausibleUpc || plausibleEan));
      wouldAutoCreate = eligibility.eligible ? "YES -- eligible to auto-create as its own new Master Product" : `NO -- ${eligibility.reason}`;

      const fresh = matchSupplierRow(
        { offerKey: suspicious.offerKey, supplierSku: suspicious.offerKey, description: suspicious.description, brand: suspicious.brandField, upc: suspicious.upc, ean: suspicious.ean },
        products,
        [],
        referenceProducts,
        pool
      );
      const candId = fresh.candidateReferenceProductId ?? fresh.candidateProductId ?? fresh.referenceProductId ?? fresh.productId;
      if (candId && candId !== f.identity) {
        const rp2 = referenceProductById.get(candId);
        const p2 = productById.get(candId);
        closestExisting = rp2 ? `${rp2.brand} ${rp2.name} (${candId})` : p2 ? `${p2.brand} ${p2.name} (${candId})` : candId;
      } else {
        closestExisting = "None found -- would remain new_candidate / genuinely new";
      }
    }

    rows.push({
      masterProductId: f.identity,
      masterProductName,
      masterProductUpc: masterUpc,
      masterProductEan: masterEan,
      supplierA: f.a.supplierName,
      descriptionA: f.a.description,
      upcA: f.a.upc,
      eanA: f.a.ean,
      priceA: `${f.a.price} ${f.a.currency}`,
      qtyA: f.a.quantity ?? "",
      matchTypeA: f.a.matchType,
      reviewStatusA: f.a.reviewStatus,
      confidenceA: f.a.matchConfidence ?? "",
      supplierB: f.b.supplierName,
      descriptionB: f.b.description,
      upcB: f.b.upc,
      eanB: f.b.ean,
      priceB: `${f.b.price} ${f.b.currency}`,
      qtyB: f.b.quantity ?? "",
      matchTypeB: f.b.matchType,
      reviewStatusB: f.b.reviewStatus,
      confidenceB: f.b.matchConfidence ?? "",
      brandMatch: "Yes",
      sizeMatch: "Yes",
      concentrationMatch: "Yes",
      coreNameOverlapPct: `${Math.round(f.similarity * 100)}%`,
      whyFlagged: `Brand, size (${f.a.sizeMl}ml), and concentration (${f.a.concentration}) match, but core fragrance name is almost entirely different (${Math.round(f.similarity * 100)}% token overlap).`,
      correctOffer,
      suspiciousOffer: suspicious ? (correctOffer === "A" ? "B" : "A") : "n/a",
      recommendedAction,
      wouldAutoCreateIfUnlinked: wouldAutoCreate,
      closestExistingMasterProduct: closestExisting,
      suspiciousOfferKey: suspicious?.offerKey ?? "",
      suspiciousMatchType: suspicious?.matchType ?? "",
    });
  }

  // --- Build workbook ---
  const wb = XLSX.utils.book_new();

  // Sheet 1: SUMMARY
  const bySupplierCount = new Map<string, number>();
  for (const r of rows) {
    bySupplierCount.set(r.supplierA, (bySupplierCount.get(r.supplierA) ?? 0) + 1);
    bySupplierCount.set(r.supplierB, (bySupplierCount.get(r.supplierB) ?? 0) + 1);
  }
  const byMatchType = new Map<string, number>();
  for (const r of rows) {
    byMatchType.set(r.matchTypeA, (byMatchType.get(r.matchTypeA) ?? 0) + 1);
    byMatchType.set(r.matchTypeB, (byMatchType.get(r.matchTypeB) ?? 0) + 1);
  }
  const byAction = new Map<string, number>();
  for (const r of rows) byAction.set(r.recommendedAction, (byAction.get(r.recommendedAction) ?? 0) + 1);
  const distinctMasterProducts = new Set(rows.map((r) => r.masterProductId)).size;

  const summaryData = [
    { Metric: "Total flagged pairs", Value: rows.length },
    { Metric: "Total affected Master Products", Value: distinctMasterProducts },
    { Metric: "", Value: "" },
    { Metric: "--- Count by supplier (appearances across A+B) ---", Value: "" },
    ...[...bySupplierCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ Metric: k, Value: v })),
    { Metric: "", Value: "" },
    { Metric: "--- Count by matchType (appearances across A+B) ---", Value: "" },
    ...[...byMatchType.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ Metric: k, Value: v })),
    { Metric: "", Value: "" },
    { Metric: "--- Count by recommended action ---", Value: "" },
    ...[...byAction.entries()].map(([k, v]) => ({ Metric: k, Value: v })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryData), "SUMMARY");

  // Sheet 2: ALL FLAGGED PAIRS
  const allPairsData = rows.map((r, i) => ({
    "#": i + 2,
    "Master Product ID": r.masterProductId,
    "Master Product Name": r.masterProductName,
    "Master Product UPC": r.masterProductUpc,
    "Master Product EAN": r.masterProductEan,
    "Supplier A": r.supplierA,
    "Offer A Description": r.descriptionA,
    "Offer A UPC": r.upcA,
    "Offer A EAN": r.eanA,
    "Offer A Price": r.priceA,
    "Offer A Qty": r.qtyA,
    "Offer A matchType": r.matchTypeA,
    "Offer A reviewStatus": r.reviewStatusA,
    "Offer A Confidence": r.confidenceA,
    "Supplier B": r.supplierB,
    "Offer B Description": r.descriptionB,
    "Offer B UPC": r.upcB,
    "Offer B EAN": r.eanB,
    "Offer B Price": r.priceB,
    "Offer B Qty": r.qtyB,
    "Offer B matchType": r.matchTypeB,
    "Offer B reviewStatus": r.reviewStatusB,
    "Offer B Confidence": r.confidenceB,
    "Brand Match?": r.brandMatch,
    "Size Match?": r.sizeMatch,
    "Concentration Match?": r.concentrationMatch,
    "Core Name Overlap": r.coreNameOverlapPct,
    "Why Flagged": r.whyFlagged,
    "Correct Offer": r.correctOffer,
    "Suspicious Offer": r.suspiciousOffer,
    "Recommended Action": r.recommendedAction,
    "Would Auto-Create If Unlinked?": r.wouldAutoCreateIfUnlinked,
    "Closest Existing Master Product": r.closestExistingMasterProduct,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allPairsData), "ALL FLAGGED PAIRS");

  // Sheet 3: NON-MANUAL-LINK CASES (suspicious offer's own matchType isn't "manual")
  const nonManual = rows.filter((r) => r.suspiciousMatchType && r.suspiciousMatchType !== "manual");
  const nonManualData = nonManual.map((r, i) => ({
    "#": i + 2,
    "Master Product ID": r.masterProductId,
    "Master Product Name": r.masterProductName,
    "Suspicious Offer matchType": r.suspiciousMatchType,
    "Supplier A": r.supplierA,
    "Offer A Description": r.descriptionA,
    "Offer A matchType": r.matchTypeA,
    "Supplier B": r.supplierB,
    "Offer B Description": r.descriptionB,
    "Offer B matchType": r.matchTypeB,
    "Correct Offer": r.correctOffer,
    "Suspicious Offer": r.suspiciousOffer,
    "Core Name Overlap": r.coreNameOverlapPct,
    "Why This Needs Deeper Root-Cause Analysis": "The suspicious offer was NOT linked via the manual 'Link to tracked item' action -- its matchType suggests an automated or upload-time resolution produced this link, which is a DIFFERENT mechanism than the confirmed Dior Homme / Miss Dior case and needs its own trace before assuming the same fix applies.",
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(nonManualData), "NON-MANUAL-LINK CASES");

  const outPath = path.resolve(__dirname, "..", "backups", `cross-fragrance-mismatches-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`);
  XLSX.writeFile(wb, outPath);
  console.log(`\nReport written to: ${outPath}`);

  // Reconciliation printout
  console.log(`\n=== Reconciliation ===`);
  console.log(`Total flagged pairs: ${rows.length}`);
  console.log(`Distinct affected Master Products: ${distinctMasterProducts}`);
  console.log(`Recommended UNLINK SUSPICIOUS OFFER: ${byAction.get("UNLINK SUSPICIOUS OFFER") ?? 0}`);
  console.log(`Recommended NEEDS HUMAN REVIEW: ${byAction.get("NEEDS HUMAN REVIEW") ?? 0}`);
  console.log(`Recommended KEEP: ${byAction.get("KEEP") ?? 0}`);
  console.log(`Non-manual-link cases (separate worksheet): ${nonManual.length}`);
}
main();
