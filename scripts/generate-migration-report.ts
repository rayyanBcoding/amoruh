// READ-ONLY. Generates a full Excel workbook of the migration dry-run's
// proposals, for human review before approving production execution.
// Mirrors migrate-backlog-dry-run.ts's own classification exactly (same
// functions, same sequential per-supplier walk with a growing pool) so
// the report can never drift from what the real dry run would report.
// Zero writes to Redis. Writes one local .xlsx file.
import * as XLSX from "xlsx";
import path from "path";
import { getSuppliers } from "../src/lib/intake-db";
import { getCommittedOffers, getAllReferenceProducts } from "../src/lib/pricing-db";
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
  buildBrandBucketedPool,
  buildMasterCandidatePool,
  addToBrandBucketedPool,
  narrowPoolForRow,
  scoreStructuredMatch,
  type MasterCandidate,
  type StructuredAttributes,
  type BrandBucketedPool,
} from "../src/lib/pricing-matching";
import type { PricingReferenceProduct, SupplierOfferCurrent } from "../src/lib/pricing-types";
import type { Product } from "../src/lib/types";

const NOMINAL_ML_VALUES = new Set([30, 50, 60, 100, 125]);

function describeMismatch(rowAttrs: StructuredAttributes, candidate: MasterCandidate, score: ReturnType<typeof scoreStructuredMatch>): string {
  const c = candidate.attrs;
  if (!score.gate.passes) {
    if (rowAttrs.brandToken !== c.brandToken) return `different brand ("${rowAttrs.brandToken}" vs "${c.brandToken}")`;
    if (rowAttrs.isTester !== c.isTester) return `tester mismatch (row=${rowAttrs.isTester}, existing=${c.isTester})`;
    if (rowAttrs.isGiftSet !== c.isGiftSet) return `gift-set mismatch (row=${rowAttrs.isGiftSet}, existing=${c.isGiftSet})`;
    if (rowAttrs.isRefill !== c.isRefill) return `refill mismatch (row=${rowAttrs.isRefill}, existing=${c.isRefill})`;
    if (rowAttrs.productForm !== c.productForm) return `different product form (row=${rowAttrs.productForm}, existing=${c.productForm})`;
    if (rowAttrs.sizeMl !== null && c.sizeMl !== null) return `different size (row=${rowAttrs.sizeMl}ml, existing=${c.sizeMl}ml)`;
    if (rowAttrs.concentration !== null && c.concentration !== null) return `different concentration (row=${rowAttrs.concentration}, existing=${c.concentration})`;
    return "hard-gate mismatch (unspecified)";
  }
  return `same brand/size/concentration/form, but different name/flanker — text similarity only ${score.confidence.toFixed(2)} (below auto-match threshold)`;
}

async function main() {
  const suppliers = await getSuppliers();
  const products: Product[] = await getProducts();
  const pool: PricingReferenceProduct[] = await getAllReferenceProducts();

  type CreationRow = {
    supplier: string; description: string; proposedName: string; brand: string; sizeMl: number | null;
    concentration: string | null; productForm: string; isTester: boolean; isGiftSet: boolean; isRefill: boolean;
    upc: string; ean: string; price: number; quantity: number | null; signature: string; reason: string;
    closestExisting: string; whyNotMatch: string; duplicateCheck: string; flags: string[];
  };
  type LinkRow = { supplier: string; description: string; price: number; quantity: number | null; targetId: string; targetLabel: string; matchType: string; matchConfidence: number | null };
  type AmbiguousRow = { supplier: string; description: string; reason: string };

  const creationRows: CreationRow[] = [];
  const linkRows: LinkRow[] = [];
  const ambiguousRows: AmbiguousRow[] = [];
  const invalidCount = { unsupported: 0, other: 0 };
  const conflictRows: { supplier: string; description: string }[] = [];

  const runningPool = [...pool];
  // Built ONCE, updated incrementally per creation (addToBrandBucketedPool)
  // — rebuilding this from the full ~11,637-candidate pool on every one
  // of 1,826+ rows was measured directly as a severe perf regression
  // (the same "80ms/row" class of bug pricing-matching.ts's own comments
  // warn about), confirmed live: killed after 200 rows took several
  // minutes on its own.
  const bucketedPool: BrandBucketedPool = buildBrandBucketedPool(buildMasterCandidatePool(products, runningPool));
  const createdIdentitiesForDupCheck: { signature: string; attrs: StructuredAttributes; index: number }[] = [];

  let processed = 0;
  for (const s of suppliers) {
    const offers = Object.values(await getCommittedOffers(s.id)).filter((o) => o.currentlyListed !== false);
    const unresolved = offers.filter((o: SupplierOfferCurrent) => !o.productId && !o.referenceProductId && (o.reviewStatus === "needs_review" || o.reviewStatus === "new_candidate"));

    for (const o of unresolved) {
      const row = { offerKey: o.offerKey, supplierSku: o.supplierSku, description: o.description, brand: o.brand, upc: o.upc, ean: o.ean };
      if (!isValidProductRow(row)) {
        if (isUnsupportedMerchandise(o.description)) invalidCount.unsupported++;
        else invalidCount.other++;
        continue;
      }

      const freshMatch = matchSupplierRow(row, products, [], runningPool, bucketedPool);

      if (freshMatch.reviewStatus === "auto_matched" && (freshMatch.productId || freshMatch.referenceProductId)) {
        const targetId = freshMatch.productId ?? freshMatch.referenceProductId!;
        const targetRef = pool.find((rp) => rp.id === targetId);
        const targetProduct = products.find((p) => p.id === targetId);
        linkRows.push({
          supplier: s.name, description: o.description, price: o.price, quantity: o.quantity,
          targetId, targetLabel: targetRef ? `${targetRef.brand} ${targetRef.name}` : targetProduct ? `${targetProduct.brand} ${targetProduct.name}` : targetId,
          matchType: freshMatch.matchType, matchConfidence: freshMatch.matchConfidence,
        });
        continue;
      }
      if (freshMatch.reviewStatus === "barcode_conflict") {
        conflictRows.push({ supplier: s.name, description: o.description });
        continue;
      }
      if (freshMatch.reviewStatus === "needs_review") {
        ambiguousRows.push({ supplier: s.name, description: o.description, reason: `needs_review — competing candidate(s): ${freshMatch.candidateReferenceProductId ?? freshMatch.candidateProductId ?? "unspecified"}` });
        continue;
      }

      // new_candidate branch
      const effectiveBrand = resolveEffectiveBrand(row, products, runningPool);
      const attrs = extractAttributes(`${o.brand} ${o.description}`, effectiveBrand);
      const plausibleUpc = isPlausibleBarcode(o.upc.trim().toUpperCase()) ? o.upc.trim() : "";
      const plausibleEan = isPlausibleBarcode(o.ean.trim().toUpperCase()) ? o.ean.trim() : "";
      const eligibility = checkAutoCreateEligibility(attrs, Boolean(plausibleUpc || plausibleEan));
      if (!eligibility.eligible) {
        ambiguousRows.push({ supplier: s.name, description: o.description, reason: `ineligible for auto-creation — ${eligibility.reason}` });
        continue;
      }

      const signature = computeIdentitySignature(attrs);

      // Closest-existing-candidate search, regardless of hard-gate pass —
      // reuses the SAME incrementally-updated bucketedPool, not a rebuild.
      const narrowed = narrowPoolForRow(attrs, bucketedPool);
      let closestExisting = "none found (no existing Master Product shares this brand)";
      let whyNotMatch = "no candidate in this brand bucket at all";
      if (narrowed.length > 0) {
        const scored = narrowed.map((c) => ({ c, score: scoreStructuredMatch(attrs, c.attrs) })).sort((a, b) => b.score.confidence - a.score.confidence);
        const top = scored[0];
        closestExisting = `${top.c.attrs.brandToken} | size=${top.c.attrs.sizeMl}ml conc=${top.c.attrs.concentration} (score=${top.score.confidence.toFixed(2)})`;
        whyNotMatch = describeMismatch(attrs, top.c, top.score);
      }

      const flags: string[] = [];
      if (!effectiveBrand || effectiveBrand.toUpperCase() === "UNDEFINED") flags.push("MISSING/UNDEFINED BRAND");
      if (attrs.sizeMl !== null && !Number.isInteger(attrs.sizeMl) && !NOMINAL_ML_VALUES.has(attrs.sizeMl)) {
        // A non-round ml value (e.g. 88.7, 198.1, 201.1) means this size came from the
        // oz->ml formula fallback (a non-curated oz value), not a directly-stated ml
        // figure or one of the curated nominal conversions -- worth a human glance.
        flags.push(`NON-STANDARD SIZE (${attrs.sizeMl}ml — formula-derived from oz, verify against source row)`);
      }
      if (o.description.trim().length < 8) flags.push("SUSPICIOUS SHORT DESCRIPTION");
      if (!plausibleUpc && !plausibleEan) flags.push("NO BARCODE (eligible via structural completeness only)");

      const index = creationRows.length;
      createdIdentitiesForDupCheck.push({ signature, attrs, index });
      creationRows.push({
        supplier: s.name, description: o.description, proposedName: o.description.trim(), brand: effectiveBrand,
        sizeMl: attrs.sizeMl, concentration: attrs.concentration, productForm: attrs.productForm,
        isTester: attrs.isTester, isGiftSet: attrs.isGiftSet, isRefill: attrs.isRefill,
        upc: plausibleUpc, ean: plausibleEan, price: o.price, quantity: o.quantity, signature,
        reason: `No existing Master Product or real Product matched this identity after checking exact UPC/EAN, canonical signature, and structural attributes (brand+size+concentration+form+tester/giftset/refill). Fully specified (brand, core name, size, concentration-or-non-fragrance-form) — eligible for auto-creation.`,
        closestExisting, whyNotMatch, duplicateCheck: "pending", flags,
      });

      const newPlaceholder: PricingReferenceProduct = {
        id: `dryrun_${o.offerKey}`, brand: effectiveBrand, name: o.description.trim(), description: o.description.trim(),
        sizeMl: attrs.sizeMl, concentration: attrs.concentration, isTester: attrs.isTester, isGiftSet: attrs.isGiftSet,
        isRefill: attrs.isRefill, productForm: attrs.productForm, upc: plausibleUpc, ean: plausibleEan, productId: null,
        createdAt: new Date().toISOString(), createdBy: "auto_import", creationMethod: "auto_import",
        createdFromSupplierId: s.id, createdFromUploadId: "report-generation-dryrun", createdFromOfferKey: o.offerKey,
      };
      runningPool.push(newPlaceholder);
      addToBrandBucketedPool(bucketedPool, { productId: null, referenceProductId: newPlaceholder.id, attrs, upc: plausibleUpc, ean: plausibleEan });
      processed++;
      if (processed % 200 === 0) console.log(`  ...${processed} creation rows processed`);
    }
  }

  console.log(`Classified: ${creationRows.length} creations, ${linkRows.length} links, ${ambiguousRows.length} ambiguous, ${conflictRows.length} conflicts, ${invalidCount.unsupported} unsupported, ${invalidCount.other} other-invalid.`);

  // Duplicate-check pass: exact signature collisions (cheap) +
  // pairwise real-matcher equivalence within same brand/size-tolerance/
  // concentration groups (same technique validated on the Game of
  // Spades set), bounded to only the 1,826 creation rows.
  console.log("Running duplicate-check pass (signature collisions + pairwise equivalence within brand/size/concentration groups)...");
  const bySignature = new Map<string, number[]>();
  createdIdentitiesForDupCheck.forEach(({ signature, index }) => {
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature)!.push(index);
  });
  for (const [, indices] of bySignature) {
    if (indices.length > 1) indices.forEach((i) => (creationRows[i].duplicateCheck = `SIGNATURE COLLISION with row(s) ${indices.filter((x) => x !== i).map((x) => x + 2).join(",")}`));
  }

  const groups = new Map<string, number[]>();
  for (const { attrs, index } of createdIdentitiesForDupCheck) {
    const key = `${attrs.brandToken}|${attrs.concentration}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(index);
  }
  let pairwiseFlagged = 0;
  for (const [, indices] of groups) {
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const rowA = creationRows[indices[i]];
        const rowB = creationRows[indices[j]];
        if (rowA.sizeMl === null || rowB.sizeMl === null) continue;
        const diff = Math.abs(rowA.sizeMl - rowB.sizeMl);
        if (!(diff <= 3 || diff / Math.max(rowA.sizeMl, rowB.sizeMl) <= 0.04)) continue;
        const matchRowA = { offerKey: `check_${indices[i]}`, supplierSku: "", description: rowA.description, brand: "", upc: "", ean: "" };
        const candidateB: PricingReferenceProduct = {
          id: `check_${indices[j]}`, brand: rowB.brand, name: rowB.description, description: rowB.description,
          sizeMl: rowB.sizeMl, concentration: rowB.concentration, isTester: rowB.isTester, isGiftSet: rowB.isGiftSet,
          isRefill: rowB.isRefill, productForm: rowB.productForm, upc: "", ean: "", productId: null,
          createdAt: "", createdBy: "", creationMethod: "auto_import", createdFromSupplierId: null, createdFromUploadId: null, createdFromOfferKey: null,
        };
        const result = matchSupplierRow(matchRowA, [], [], [candidateB]);
        if (result.reviewStatus === "auto_matched") {
          rowA.duplicateCheck = rowA.duplicateCheck === "pending" ? `POSSIBLE DUPLICATE of row ${indices[j] + 2}` : rowA.duplicateCheck;
          rowB.duplicateCheck = rowB.duplicateCheck === "pending" ? `POSSIBLE DUPLICATE of row ${indices[i] + 2}` : rowB.duplicateCheck;
          pairwiseFlagged++;
        }
      }
    }
  }
  creationRows.forEach((r) => {
    if (r.duplicateCheck === "pending") r.duplicateCheck = "no duplicate detected";
  });
  console.log(`Duplicate check complete. Pairwise equivalence flags: ${pairwiseFlagged}`);

  // Ambiguous summary, grouped by reason bucket.
  const ambiguousByReason = new Map<string, number>();
  for (const r of ambiguousRows) {
    const bucket = r.reason.split(" — ")[0].split(" (")[0];
    ambiguousByReason.set(bucket, (ambiguousByReason.get(bucket) ?? 0) + 1);
  }

  // --- Build workbook ---
  const wb = XLSX.utils.book_new();

  const creationSheetData = creationRows.map((r, i) => ({
    "#": i + 2,
    Supplier: r.supplier,
    "Original Description": r.description,
    "Proposed Master Product Name": r.proposedName,
    Brand: r.brand,
    Concentration: r.concentration ?? "",
    "Size (ml)": r.sizeMl ?? "",
    "Product Form": r.productForm,
    Tester: r.isTester ? "Y" : "",
    "Gift Set": r.isGiftSet ? "Y" : "",
    Refill: r.isRefill ? "Y" : "",
    UPC: r.upc,
    EAN: r.ean,
    "Supplier Price": r.price,
    "Supplier Qty": r.quantity ?? "",
    "Identity Signature": r.signature,
    "Reason New Master Product Required": r.reason,
    "Closest Existing Master Product": r.closestExisting,
    "Why Not An Exact Match": r.whyNotMatch,
    "Duplicate-Check Result": r.duplicateCheck,
    Flags: r.flags.join("; "),
  }));
  const wsCreations = XLSX.utils.json_to_sheet(creationSheetData);
  XLSX.utils.book_append_sheet(wb, wsCreations, "New Master Products");

  const linkSheetData = linkRows.map((r, i) => ({
    "#": i + 2, Supplier: r.supplier, "Original Description": r.description, "Supplier Price": r.price,
    "Supplier Qty": r.quantity ?? "", "Links To (ID)": r.targetId, "Links To (Name)": r.targetLabel,
    "Match Type": r.matchType, "Match Confidence": r.matchConfidence ?? "",
  }));
  const wsLinks = XLSX.utils.json_to_sheet(linkSheetData);
  XLSX.utils.book_append_sheet(wb, wsLinks, "Existing Links");

  const ambiguousSummaryData = [...ambiguousByReason.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ Reason: reason, Count: count }));
  const wsAmbSummary = XLSX.utils.json_to_sheet(ambiguousSummaryData);
  XLSX.utils.book_append_sheet(wb, wsAmbSummary, "Ambiguous Summary");

  const ambiguousDetailData = ambiguousRows.map((r, i) => ({ "#": i + 2, Supplier: r.supplier, Description: r.description, Reason: r.reason }));
  const wsAmbDetail = XLSX.utils.json_to_sheet(ambiguousDetailData);
  XLSX.utils.book_append_sheet(wb, wsAmbDetail, "Ambiguous Detail");

  const flaggedData = creationSheetData.filter((r) => r.Flags || r["Duplicate-Check Result"] !== "no duplicate detected");
  const wsFlagged = XLSX.utils.json_to_sheet(flaggedData);
  XLSX.utils.book_append_sheet(wb, wsFlagged, "Flagged For Review");

  const summarySheetData = [
    { Metric: "Report generated at", Value: new Date().toISOString() },
    { Metric: "Total unresolved offers examined", Value: creationRows.length + linkRows.length + ambiguousRows.length + conflictRows.length + invalidCount.unsupported + invalidCount.other },
    { Metric: "New Master Products proposed", Value: creationRows.length },
    { Metric: "Links to existing Master/real Products", Value: linkRows.length },
    { Metric: "Genuinely ambiguous (left in Match Review)", Value: ambiguousRows.length },
    { Metric: "Identity conflicts", Value: conflictRows.length },
    { Metric: "Unsupported merchandise (excluded)", Value: invalidCount.unsupported },
    { Metric: "Other invalid rows (excluded)", Value: invalidCount.other },
    { Metric: "Rows flagged for manual review", Value: flaggedData.length },
    { Metric: "Signature collisions among proposals", Value: [...bySignature.values()].filter((v) => v.length > 1).length },
    { Metric: "Pairwise real-matcher equivalence flags", Value: pairwiseFlagged },
  ];
  const wsSummary = XLSX.utils.json_to_sheet(summarySheetData);
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

  const outPath = path.resolve(__dirname, "..", "backups", `migration-proposal-report-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`);
  XLSX.writeFile(wb, outPath);
  console.log(`\nReport written to: ${outPath}`);
}
main();
