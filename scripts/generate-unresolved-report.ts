// Phase 2: reads the raw audit JSON from audit-unresolved-offers.ts,
// adds price-comparison analysis against the current catalog, and
// writes the full 7-worksheet Excel report. Read-only (comparison
// lookups only), no writes.
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { getReferenceProductOfferComparison, getProductOfferComparison } from "../src/lib/pricing-db";

interface AuditRow {
  supplier: string; supplierId: string; offerKey: string; description: string; brand: string;
  upc: string; ean: string; supplierSku: string; price: number; quantity: number | null;
  parsedBrand: string; parsedName: string; sizeMl: number | null; concentration: string | null;
  productForm: string; isTester: boolean; isGiftSet: boolean; isRefill: boolean;
  storedReviewStatus: string; storedMatchType: string; storedReferenceProductId: string | null; storedProductId: string | null;
  freshReviewStatus: string; freshMatchType: string; freshCandidateId: string | null;
  category: string; reasonDetail: string; contributingIssues: string[];
  existsAlready: string; closestCandidateLabel: string; closestCandidateScore: number | null;
  action: string; actionEvidence: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  A_missing_brand: "A. Missing or unrecognized brand",
  B_missing_size: "B. Missing or unrecognized size",
  C_missing_concentration: "C. Missing or unclear concentration",
  D_name_unidentifiable: "D. Fragrance name/flanker cannot be identified",
  E_multiple_candidates: "E. Multiple possible Master Products",
  F_upc_ean_alias_conflict: "F. Conflicting UPC/EAN or alias",
  G_form_tester_giftset_uncertain: "G. Tester/refill/gift-set/product-form uncertainty",
  H_logistics_confusion: "H. Logistics/packaging text confusion",
  I_matching_logic_gap: "I. Matching logic gap / stale status",
  J_other_unsupported: "J. Other / unsupported merchandise",
};

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("Usage: npx tsx scripts/generate-unresolved-report.ts <audit.json>");
    process.exit(1);
  }
  const { rows } = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { rows: AuditRow[] };
  console.log(`Loaded ${rows.length} audit rows.`);

  // Reconciliation
  const byCategory = new Map<string, number>();
  for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
  const total = [...byCategory.values()].reduce((a, b) => a + b, 0);
  console.log(`Reconciliation: sum of categories = ${total}, total rows = ${rows.length}, ${total === rows.length ? "MATCH" : "MISMATCH"}`);

  // --- Price comparison analysis for rows with a real candidate ---
  console.log("\nRunning price-comparison analysis for rows with an identified candidate...");
  const priceComparisons: {
    row: AuditRow; candidateLabel: string; candidateId: string; currentBestPriceUsd: number | null;
    currentLinkedOffers: string; unresolvedPriceUsd: number; priceDifference: number | null;
    confirmedIdentity: boolean; reason: string; autoFixable: boolean;
  }[] = [];

  const candidateCache = new Map<string, { bestPriceUsd: number | null; linkedSummary: string }>();
  let compChecked = 0;
  for (const r of rows) {
    // Unsupported/invalid rows never run through fresh matching at all
    // (audit script short-circuits before matchSupplierRow) -- their
    // freshCandidateId, if present, is a stale leftover from the
    // offer's old stored state, not a real candidate. Skip them.
    if (!r.freshCandidateId || r.existsAlready === "unsupported") continue;
    compChecked++;
    if (compChecked % 100 === 0) console.log(`  ...${compChecked} candidates checked`);
    let cached = candidateCache.get(r.freshCandidateId);
    if (!cached) {
      try {
        const isProduct = r.storedProductId === r.freshCandidateId || (!r.freshCandidateId.startsWith("refprod_") && !r.freshCandidateId.startsWith("dryrun_"));
        const comparison = isProduct ? await getProductOfferComparison(r.freshCandidateId) : await getReferenceProductOfferComparison(r.freshCandidateId);
        const bestPriceUsd = comparison.bestPrice?.priceUsd ?? null;
        const linkedSummary = comparison.actionable.map((a) => `${a.supplierName}:$${a.priceUsd.toFixed(2)}`).join("; ") || "(no actionable offers yet)";
        cached = { bestPriceUsd, linkedSummary };
      } catch {
        cached = { bestPriceUsd: null, linkedSummary: "(lookup failed)" };
      }
      candidateCache.set(r.freshCandidateId, cached);
    }
    const confirmedIdentity = r.existsAlready === "exact_match_not_linked" && r.action === "AUTO_FIXABLE";
    const priceDiff = cached.bestPriceUsd !== null ? r.price - cached.bestPriceUsd : null;
    priceComparisons.push({
      row: r, candidateLabel: r.closestCandidateLabel, candidateId: r.freshCandidateId,
      currentBestPriceUsd: cached.bestPriceUsd, currentLinkedOffers: cached.linkedSummary,
      unresolvedPriceUsd: r.price, priceDifference: priceDiff,
      confirmedIdentity, reason: r.reasonDetail, autoFixable: r.action === "AUTO_FIXABLE",
    });
  }
  console.log(`Price comparisons computed: ${priceComparisons.length}`);
  const cheaperCount = priceComparisons.filter((c) => c.priceDifference !== null && c.priceDifference < 0).length;
  console.log(`Of which the unresolved offer is CHEAPER than the current best price: ${cheaperCount}`);

  // --- Build workbook ---
  const wb = XLSX.utils.book_new();

  // Sheet 1: EXECUTIVE SUMMARY
  const bySupplier = new Map<string, number>();
  for (const r of rows) bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + 1);
  const byAction = new Map<string, number>();
  for (const r of rows) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
  const summaryData = [
    { Section: "TOTAL UNRESOLVED (fresh, current)", Value: rows.length },
    { Section: "", Value: "" },
    { Section: "--- By Supplier ---", Value: "" },
    ...[...bySupplier.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ Section: k, Value: v })),
    { Section: "", Value: "" },
    { Section: "--- By Root Cause ---", Value: "" },
    ...[...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ Section: CATEGORY_LABELS[k] ?? k, Value: v })),
    { Section: "", Value: "" },
    { Section: "--- By Proposed Action ---", Value: "" },
    ...[...byAction.entries()].map(([k, v]) => ({ Section: k, Value: v })),
    { Section: "", Value: "" },
    { Section: "--- Price Comparison ---", Value: "" },
    { Section: "Rows with an identified candidate to compare against", Value: priceComparisons.length },
    { Section: "Unresolved offer is CHEAPER than current best price", Value: cheaperCount },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryData), "EXECUTIVE SUMMARY");

  // Sheet 2: ALL UNRESOLVED OFFERS
  const allSheetData = rows.map((r, i) => ({
    "#": i + 2, Supplier: r.supplier, "Original Description": r.description, Brand: r.brand,
    UPC: r.upc, EAN: r.ean, "Supplier SKU": r.supplierSku, Price: r.price, Quantity: r.quantity ?? "",
    "Parsed Brand": r.parsedBrand, "Parsed Name": r.parsedName, "Size (ml)": r.sizeMl ?? "", Concentration: r.concentration ?? "",
    "Product Form": r.productForm, Tester: r.isTester ? "Y" : "", "Gift Set": r.isGiftSet ? "Y" : "", Refill: r.isRefill ? "Y" : "",
    "Stored ReviewStatus": r.storedReviewStatus, "Stored MatchType": r.storedMatchType,
    "Fresh ReviewStatus": r.freshReviewStatus, "Fresh MatchType": r.freshMatchType,
    "Root Cause": CATEGORY_LABELS[r.category] ?? r.category, "Reason Detail": r.reasonDetail,
    "Contributing Issues": r.contributingIssues.join("; "), "Exists Already": r.existsAlready,
    "Closest Candidate": r.closestCandidateLabel, "Candidate Score": r.closestCandidateScore ?? "",
    "Proposed Action": r.action, "Action Evidence": r.actionEvidence,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allSheetData), "ALL UNRESOLVED OFFERS");

  // Sheet 3: AUTO-FIXABLE, grouped by root cause
  const autoFixable = rows.filter((r) => r.action === "AUTO_FIXABLE");
  const autoFixGroups = new Map<string, AuditRow[]>();
  for (const r of autoFixable) {
    const key = `${r.category}|${r.reasonDetail.split(" — ")[0].split(":")[0]}`;
    if (!autoFixGroups.has(key)) autoFixGroups.set(key, []);
    autoFixGroups.get(key)!.push(r);
  }
  const autoFixData: Record<string, string | number>[] = [];
  for (const [key, group] of [...autoFixGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    autoFixData.push({ Supplier: "=== GROUP ===", "Original Description": key.split("|")[1] ?? key, Brand: `${group.length} offers`, UPC: "", EAN: "", "Proposed Correction": group[0].actionEvidence });
    for (const r of group.slice(0, 10)) {
      autoFixData.push({ Supplier: r.supplier, "Original Description": r.description, Brand: r.parsedBrand, UPC: r.upc, EAN: r.ean, "Proposed Correction": r.category === "A_missing_brand" ? "assign brand, then re-process" : r.category === "I_matching_logic_gap" ? `link to ${r.closestCandidateLabel}` : "" });
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(autoFixData), "AUTO-FIXABLE");

  // Sheet 4: POSSIBLE MISSING CHEAPER OFFERS
  const priceSheetData = priceComparisons
    .filter((c) => c.currentBestPriceUsd !== null)
    .sort((a, b) => (a.priceDifference ?? 0) - (b.priceDifference ?? 0))
    .map((c, i) => ({
      "#": i + 2, "Master Product / Candidate": c.candidateLabel, "Current Linked Supplier Prices (USD)": c.currentLinkedOffers,
      "Current Best Price (USD)": c.currentBestPriceUsd, "Unresolved Supplier": c.row.supplier, "Unresolved Description": c.row.description,
      "Unresolved Price (USD)": c.unresolvedPriceUsd, "Price Difference (unresolved - current best)": c.priceDifference,
      "Cheaper?": c.priceDifference !== null && c.priceDifference < 0 ? "YES — potentially cheaper" : "no",
      "Confirmed Identity or Uncertain": c.confirmedIdentity ? "CONFIRMED" : "UNCERTAIN — do not treat as a real price comparison yet",
      "Exact Reason Not Linked": c.reason, "Safe Auto-Fix Possible": c.autoFixable ? "YES" : "NO",
    }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(priceSheetData), "POSSIBLE MISSING CHEAPER OFFERS");

  // Sheet 5: NEEDS SUPPLIER INFORMATION
  const needsInfo = rows.filter((r) => r.action === "NEEDS_SUPPLIER_INFO").map((r, i) => ({
    "#": i + 2, Supplier: r.supplier, "Original Description": r.description, "Root Cause": CATEGORY_LABELS[r.category] ?? r.category,
    "Missing Information": r.reasonDetail, UPC: r.upc, EAN: r.ean, Price: r.price,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(needsInfo), "NEEDS SUPPLIER INFORMATION");

  // Sheet 6: HUMAN REVIEW
  const humanReview = rows.filter((r) => r.action === "NEEDS_OUR_DECISION").map((r, i) => ({
    "#": i + 2, Supplier: r.supplier, "Original Description": r.description, "Root Cause": CATEGORY_LABELS[r.category] ?? r.category,
    "Reason": r.reasonDetail, "Closest Candidate": r.closestCandidateLabel, "Candidate Score": r.closestCandidateScore ?? "",
    "Suggested Choice": r.closestCandidateLabel ? `Confirm or reject link to "${r.closestCandidateLabel}"` : "Confirm this is a genuinely new product",
    "Supporting Evidence": r.actionEvidence,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(humanReview), "HUMAN REVIEW");

  // Sheet 7: SYSTEMIC BUGS
  const matchingLogicGaps = rows.filter((r) => r.category === "I_matching_logic_gap");
  const productFormGapRows = rows.filter((r) => r.contributingIssues.some((c) => c.startsWith("PRODUCT-FORM GAP")));
  const productFormGapConcRows = productFormGapRows.filter((r) => r.category === "C_missing_concentration");
  const jizanConflicts = rows.filter((r) => r.category === "F_upc_ean_alias_conflict" && r.supplier.includes("Jizan"));
  const systemicData = [
    {
      Issue: "classifyProductForm() (src/lib/pricing-matching.ts) does not recognize body mist, hair mist, fragrance mist, room/linen spray, perfume concentrate, or non-fragrance cosmetics/accessories (cream, foundation, mascara, lip products, bags, cases) — these silently default to productForm \"fragrance\"",
      "Affected Count": `${productFormGapRows.length} total rows carry this flag; ${productFormGapConcRows.length} of those were specifically miscategorized/blocked as \"concentration ambiguous\" because of it (roughly a quarter of ALL unresolved offers)`,
      Example: productFormGapConcRows[0]?.description ?? "(none found)",
      "Proposed Fix": "Extend PRODUCT_FORM_PATTERNS with new ProductForm values for these categories (e.g. \"body_mist\", \"cosmetic\", \"accessory\") — the concentration-required gate in checkAutoCreateEligibility (line 971) already exempts any non-\"fragrance\" productForm, so this one pattern-list addition should let a meaningful share of this bucket auto-create or match correctly on the next processing pass without any other logic change. Verify on a sample before trusting broadly — some of these (bags, cases, key rings) are themselves unsupported merchandise, not sellable SKUs, and should route to isUnsupportedMerchandise instead.",
    },
    {
      Issue: "Jizan alias_conflict cluster traces to a small number of bulk auto_high_confidence alias-creation events, not ongoing day-to-day ambiguity",
      "Affected Count": `${jizanConflicts.length} of Jizan's 665 unresolved offers (all reviewStatus=alias_conflict)`,
      Example: "Every inspected Jizan alias_conflict row's learned alias was created at exactly 2026-09-09T01:35:08.180Z or 2026-09-09T20:08:36.262Z (source=auto_high_confidence) — two bulk ingestion batches, not independent per-row conflicts.",
      "Proposed Fix": "Per standing instruction these aliases are never auto-deleted or overwritten. The minimal fix is process-level: review the two 2026-09-09 batches together (they are very likely one shared root cause, e.g. a scoring-threshold bug active only during those runs) rather than triaging 314 rows individually. No code change is proposed here without your review of a representative sample first.",
    },
    { Issue: "Rows where the CURRENT catalog now has a real match (post-migration) but stored status is stale", "Affected Count": matchingLogicGaps.filter((r) => r.existsAlready === "exact_match_not_linked").length, "Example": matchingLogicGaps.find((r) => r.existsAlready === "exact_match_not_linked")?.description ?? "(none found)", "Proposed Fix": "Re-run the standard match-review reprocess for these specific offerKeys — no code change needed, they already resolve correctly under current code." },
    { Issue: "Rows structurally eligible for auto-creation (identical criteria to the 1,769 the executed migration created) but never processed", "Affected Count": matchingLogicGaps.filter((r) => r.existsAlready === "genuinely_new").length, "Example": matchingLogicGaps.find((r) => r.existsAlready === "genuinely_new")?.description ?? "(none found)", "Proposed Fix": "Not a bug — simply needs one more auto-creation pass using the same get-or-create primitive and duplicate-signature safety check the executed migration used. Heavily concentrated at NMD Trading (see ALL UNRESOLVED OFFERS sheet)." },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(systemicData), "SYSTEMIC BUGS");

  const outPath = path.resolve(__dirname, "..", "backups", `unresolved-offers-report-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`);
  XLSX.writeFile(wb, outPath);
  console.log(`\nReport written to: ${outPath}`);
}
main();
