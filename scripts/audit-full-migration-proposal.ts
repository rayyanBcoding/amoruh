// READ-ONLY. Comprehensive systemic audit of the FULL migration
// proposal (not just previously-flagged rows), after the edition-number
// and bare-SET fixes. Re-classifies everything fresh with the corrected
// code, separates genuine pre-existing-catalog links from within-batch
// placeholder matches (a labeling bug in the prior report generator,
// not a migration bug), and checks UPC-repeat compatibility explicitly.
import * as XLSX from "xlsx";
import path from "path";
import { getSuppliers } from "../src/lib/intake-db";
import { getCommittedOffers, getAllReferenceProducts } from "../src/lib/pricing-db";
import { getProducts } from "../src/lib/db";
import {
  extractAttributes,
  extractProductAttributes,
  extractReferenceProductAttributes,
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
  tokenize,
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
    closestExisting: string; whyNotMatch: string; duplicateCheck: string; flags: string[]; offerKey: string;
  };
  type LinkRow = {
    supplier: string; description: string; price: number; quantity: number | null; targetId: string; targetLabel: string;
    matchType: string; matchConfidence: number | null; withinBatch: boolean; compatibilityCheck: string;
  };

  // Defense-in-depth: independently re-verify every proposed link's
  // identity compatibility, rather than trusting matchSupplierRow's own
  // outcome alone (the whole point of the audit item that found the
  // Guess 1981 / Dare Homme false match — a good matcher can still be
  // fed an impoverished row, upstream of any single fix). Flags any
  // link where the TARGET carries meaningful distinguishing words the
  // ROW's own text doesn't have at all.
  // First cut of this check flagged EVERY link (7/7) on trivial
  // wording differences ("sp" vs "spray", a brand-field data-quality
  // quirk on one specific record) that were never the actual risk —
  // rebuilt to surface the REAL signal instead: the exact precondition
  // that caused the confirmed Guess-1981/Dare-Homme false match was the
  // ROW's own core name (after stripping its brand) being so sparse
  // that almost any same-brand/size candidate would score high via
  // subset containment. Hard gates (brand/size/concentration/form/
  // tester/giftset/refill) are already enforced by matchSupplierRow
  // before a row ever reaches "auto_matched" at all — re-deriving them
  // here would just repeat, not add, verification. What's NOT re-
  // checked anywhere else is "was there enough real text to trust the
  // score in the first place," so that's what this reports.
  const TRIVIAL_ABBREVIATIONS = new Set(["sp", "spr", "edp", "edt", "edc", "tst", "l", "m", "w", "u", "b", "c"]);
  function checkLinkCompatibility(rowAttrs: StructuredAttributes, targetAttrs: StructuredAttributes, matchConfidence: number | null): string {
    const meaningfulRowWords = rowAttrs.coreNameTokens.filter((t) => t.length > 2 && !TRIVIAL_ABBREVIATIONS.has(t));
    const sparse = meaningfulRowWords.length <= 2;
    const lowConfidence = matchConfidence !== null && matchConfidence < 0.95;
    if (sparse) {
      return `VERIFY — row's own text has very little distinguishing content after removing brand/boilerplate (only: ${meaningfulRowWords.join(", ") || "none"}) — the exact pattern that caused a real false match elsewhere in this catalog (Guess 1981 / Dare Homme); confirm this isn't the same risk.`;
    }
    if (lowConfidence) {
      return `VERIFY — structural match confidence ${matchConfidence!.toFixed(2)} is below the stricter 0.95 review bar (still above the 0.85 auto-match threshold) — worth a second look.`;
    }
    return `compatible — row's own text (${meaningfulRowWords.join(", ")}) has substantive distinguishing content and confidence is high`;
  }
  type AmbiguousRow = { supplier: string; description: string; reason: string };

  const creationRows: CreationRow[] = [];
  const linkRows: LinkRow[] = [];
  const withinBatchDedupRows: LinkRow[] = [];
  const ambiguousRows: AmbiguousRow[] = [];
  const invalidCount = { unsupported: 0, other: 0 };
  const conflictRows: { supplier: string; description: string }[] = [];

  const runningPool = [...pool];
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
        const withinBatch = targetId.startsWith("dryrun_");
        const targetRef = pool.find((rp) => rp.id === targetId);
        const targetProduct = products.find((p) => p.id === targetId);
        const rowEffectiveBrand = resolveEffectiveBrand(row, products, runningPool);
        const rowAttrsForCompat = extractAttributes(`${o.brand} ${o.description}`, rowEffectiveBrand);
        const targetAttrsForCompat = targetProduct
          ? extractProductAttributes(targetProduct)
          : targetRef
            ? extractReferenceProductAttributes(targetRef)
            : null;
        const compatibilityCheck = withinBatch
          ? "n/a — within-batch dedup, not an existing-catalog link"
          : targetAttrsForCompat
            ? checkLinkCompatibility(rowAttrsForCompat, targetAttrsForCompat, freshMatch.matchConfidence)
            : "target not found — verify manually";
        const linkRow: LinkRow = {
          supplier: s.name, description: o.description, price: o.price, quantity: o.quantity,
          targetId, targetLabel: targetRef ? `${targetRef.brand} ${targetRef.name}` : targetProduct ? `${targetProduct.brand} ${targetProduct.name}` : "(this batch's own proposed creation — see New Master Products sheet)",
          matchType: freshMatch.matchType, matchConfidence: freshMatch.matchConfidence, withinBatch, compatibilityCheck,
        };
        (withinBatch ? withinBatchDedupRows : linkRows).push(linkRow);
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
        flags.push(`NON-STANDARD SIZE (${attrs.sizeMl}ml — formula-derived from oz, verify against source row)`);
      }
      if (o.description.trim().length < 8) flags.push("SUSPICIOUS SHORT DESCRIPTION");
      if (!plausibleUpc && !plausibleEan) flags.push("NO BARCODE (eligible via structural completeness only)");
      // Sanity check for the logistics-stripping fix (country/qty/ByBox)
      // — should find nothing; a residual match here means the fix has
      // a gap for this row's specific wording.
      if (attrs.coreNameTokens.some((t) => t === "bybox" || /^\d+pcs?$/.test(t))) {
        flags.push("RESIDUAL LOGISTICS TERM IN IDENTITY — verify manually");
      }
      // Numbered-edition sanity check — precise version. The first cut of
      // this check matched ANY "no"/"number" in the text, which false-
      // positived heavily on ordinary supplier annotations ("TST NO CAP",
      // "NO BOX", "NO UPC" — "without X," nothing to do with an edition)
      // and on Roman-numeral editions ("No IV", "No I") that were ALREADY
      // correctly preserved (Roman numerals were never digits, so the
      // digit-strip fix never touched them — there was nothing to flag).
      // This version only fires when "no"/"no." is directly followed by
      // an actual DIGIT in the raw text — the one case the digit-
      // preservation fix is actually responsible for.
      if (/\bno\.?\s+\d/i.test(o.description) && !attrs.coreNameTokens.some((t) => /^\d+$/.test(t))) {
        flags.push("POSSIBLE NUMBERED EDITION WITHOUT A CAPTURED NUMBER — verify manually");
      }
      // Separate, narrower case: a bare number embedded directly in the
      // product's own name with NO "No."/"#" prefix at all (e.g. Le
      // Labo's "Eucalyptus 20", "Patchouli 24" convention) — the digit-
      // preservation fix only covers the "No. X" shape, not this one.
      // Confirmed present in this exact dataset (Le Labo rows). Flagged
      // for a human to verify rather than silently dropped OR silently
      // preserved — blindly preserving every bare digit would reintroduce
      // the original noise (stray SKU/model numbers) the blanket strip
      // was there to remove.
      //
      // First cut of this check flagged ~1,800 of 1,831 rows: EVERY
      // Miami row carries its own internal SKU number in parens, e.g.
      // "(131832)" — a bare digit, not preceded by "no", not followed by
      // a unit/quantity word, so it tripped the check on pure noise.
      // Fixed by stripping parenthesized/bracketed content (where every
      // real SKU/count code in this dataset actually lives) before
      // looking for a candidate at all.
      {
        const withoutBracketedContent = o.description.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
        const rawTokens = tokenize(withoutBracketedContent.toLowerCase());
        for (let i = 0; i < rawTokens.length; i++) {
          const t = rawTokens[i];
          if (!/^\d+$/.test(t)) continue;
          if (attrs.coreNameTokens.includes(t)) continue; // already preserved
          const prev = rawTokens[i - 1];
          const next = rawTokens[i + 1];
          if (prev === "no" || prev === "no.") continue; // covered by the flag above
          if (next === "pcs" || next === "pc") continue; // quantity — correctly dropped
          if (next === "ml" || next === "oz" || next === "fl") continue; // size — correctly excluded elsewhere
          flags.push(`POSSIBLE NAME-EMBEDDED NUMBER DROPPED ("${t}") — verify manually`);
          break;
        }
      }

      const index = creationRows.length;
      createdIdentitiesForDupCheck.push({ signature, attrs, index });
      creationRows.push({
        supplier: s.name, description: o.description, proposedName: o.description.trim(), brand: effectiveBrand,
        sizeMl: attrs.sizeMl, concentration: attrs.concentration, productForm: attrs.productForm,
        isTester: attrs.isTester, isGiftSet: attrs.isGiftSet, isRefill: attrs.isRefill,
        upc: plausibleUpc, ean: plausibleEan, price: o.price, quantity: o.quantity, signature,
        reason: `No existing Master Product or real Product matched this identity after checking exact UPC/EAN, canonical signature, and structural attributes.`,
        closestExisting, whyNotMatch, duplicateCheck: "pending", flags, offerKey: o.offerKey,
      });

      const newPlaceholder: PricingReferenceProduct = {
        id: `dryrun_${o.offerKey}`, brand: effectiveBrand, name: o.description.trim(), description: o.description.trim(),
        sizeMl: attrs.sizeMl, concentration: attrs.concentration, isTester: attrs.isTester, isGiftSet: attrs.isGiftSet,
        isRefill: attrs.isRefill, productForm: attrs.productForm, upc: plausibleUpc, ean: plausibleEan, productId: null,
        createdAt: new Date().toISOString(), createdBy: "auto_import", creationMethod: "auto_import",
        createdFromSupplierId: s.id, createdFromUploadId: "audit-dryrun", createdFromOfferKey: o.offerKey,
      };
      runningPool.push(newPlaceholder);
      addToBrandBucketedPool(bucketedPool, { productId: null, referenceProductId: newPlaceholder.id, attrs, upc: plausibleUpc, ean: plausibleEan });
      processed++;
      if (processed % 200 === 0) console.log(`  ...${processed} creation rows processed`);
    }
  }

  console.log(`Classified: ${creationRows.length} creations, ${linkRows.length} genuine existing-catalog links, ${withinBatchDedupRows.length} within-batch dedup links, ${ambiguousRows.length} ambiguous, ${conflictRows.length} conflicts, ${invalidCount.unsupported} unsupported, ${invalidCount.other} other-invalid.`);

  // Duplicate-check: signature collisions + pairwise real-matcher
  // equivalence within brand/size-tolerance/concentration groups.
  console.log("Running duplicate-check pass...");
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
  console.log(`Duplicate check complete. Signature collisions: ${[...bySignature.values()].filter((v) => v.length > 1).length}. Pairwise flags: ${pairwiseFlagged}`);

  // UPC-repeat compatibility check: for every UPC shared by 2+ proposed
  // creations, confirm the identities are genuinely compatible (same
  // signature) rather than merged merely because a barcode repeats.
  console.log("\n=== UPC-repeat compatibility check (proposed creations only) ===");
  const byUpc = new Map<string, number[]>();
  createdIdentitiesForDupCheck.forEach(({ index }) => {
    const upc = creationRows[index].upc;
    if (!upc) return;
    if (!byUpc.has(upc)) byUpc.set(upc, []);
    byUpc.get(upc)!.push(index);
  });
  let upcCompatible = 0;
  let upcIncompatible = 0;
  for (const [upc, indices] of byUpc) {
    if (indices.length < 2) continue;
    const sigs = new Set(indices.map((i) => creationRows[i].signature));
    if (sigs.size === 1) {
      upcCompatible++;
    } else {
      upcIncompatible++;
      console.log(`  INCOMPATIBLE: UPC ${upc} shared by ${indices.length} rows with DIFFERENT signatures:`);
      indices.forEach((i) => console.log(`    - "${creationRows[i].description}" (sig=${creationRows[i].signature})`));
      indices.forEach((i) => creationRows[i].flags.push(`SHARED UPC WITH DIFFERENT IDENTITY (row ${indices.filter((x) => x !== i).map((x) => x + 2).join(",")})`));
    }
  }
  console.log(`Repeated UPCs among proposed creations: ${byUpc.size ? [...byUpc.values()].filter((v) => v.length > 1).length : 0} — compatible (same signature, correctly one identity): ${upcCompatible}, INCOMPATIBLE (different identity, flagged): ${upcIncompatible}`);

  // Within-batch dedup link compatibility check — same idea, applied to
  // the links that resolved against a placeholder created earlier in
  // this same walk (not yet in the "New Master Products" sheet's own
  // duplicate-check pass, since they never became a row there).
  console.log("\n=== Within-batch dedup links ===");
  console.log(`${withinBatchDedupRows.length} total — each already passed the same hard-gate + text-score check as a normal auto-match (not a separate, looser rule); see the "Within-Batch Dedup" sheet for the full list to review.`);

  const incompatibleLinks = linkRows.filter((r) => r.compatibilityCheck.startsWith("VERIFY"));
  console.log("\n=== Existing-catalog link compatibility audit (independent of matchSupplierRow's own outcome) ===");
  console.log(`${linkRows.length} genuine existing-catalog links checked.`);
  console.log(`INCOMPATIBLE (target has a distinguishing word not in the row's own text — verify before trusting): ${incompatibleLinks.length}`);
  incompatibleLinks.forEach((r) => console.log(`  - "${r.description}" -> "${r.targetLabel}" | ${r.compatibilityCheck}`));

  // --- Three-tier classification ---
  type Tier = "SAFE TO CREATE" | "NEEDS CORRECTION" | "TRULY AMBIGUOUS";
  function classify(r: CreationRow): { tier: Tier; correction: string } {
    if (r.duplicateCheck !== "no duplicate detected") {
      return { tier: "TRULY AMBIGUOUS", correction: `Identity overlaps with another proposal (${r.duplicateCheck}) — a human must confirm whether these are genuinely the same product or genuinely different before either is created.` };
    }
    if (r.flags.some((f) => f.startsWith("SHARED UPC WITH DIFFERENT IDENTITY"))) {
      return { tier: "TRULY AMBIGUOUS", correction: "Same UPC as another proposal but a DIFFERENT parsed identity — likely a data error (reused/mistyped barcode) or a genuine same-SKU pair this matcher failed to unify. Needs a human to pick the correct identity." };
    }
    if (r.flags.some((f) => f.startsWith("POSSIBLE NUMBERED EDITION"))) {
      return { tier: "TRULY AMBIGUOUS", correction: "Description references a numbered edition but no number was captured in the core name — verify the correct edition number manually before creating." };
    }
    if (r.flags.some((f) => f.startsWith("POSSIBLE NAME-EMBEDDED NUMBER"))) {
      return { tier: "TRULY AMBIGUOUS", correction: "A bare number appears to be part of this product's own name (no size/quantity/edition marker nearby) but was dropped from the parsed identity — verify manually before creating." };
    }
    if (r.flags.some((f) => f.startsWith("RESIDUAL LOGISTICS TERM"))) {
      return { tier: "TRULY AMBIGUOUS", correction: "A supplier logistics term (country/quantity/ByBox) survived into the parsed identity despite the stripping fix — verify manually; likely an unanticipated wording variant." };
    }
    if (r.flags.some((f) => f === "MISSING/UNDEFINED BRAND")) {
      return { tier: "NEEDS CORRECTION", correction: `Assign brand — the row's own text clearly names a brand ("${r.description.split(/[\[\(]/)[0].trim()}") not yet in the catalog; a real UPC anchors the identity in the meantime.` };
    }
    if (r.flags.some((f) => f === "SUSPICIOUS SHORT DESCRIPTION")) {
      return { tier: "NEEDS CORRECTION", correction: "Description is unusually short — confirm this is a real, complete product name before creating." };
    }
    return { tier: "SAFE TO CREATE", correction: "" };
  }

  const tiered = creationRows.map((r) => ({ r, ...classify(r) }));
  const safeCount = tiered.filter((t) => t.tier === "SAFE TO CREATE").length;
  const correctionCount = tiered.filter((t) => t.tier === "NEEDS CORRECTION").length;
  const ambiguousCount = tiered.filter((t) => t.tier === "TRULY AMBIGUOUS").length;
  console.log(`\n=== Three-tier classification ===`);
  console.log(`SAFE TO CREATE: ${safeCount}`);
  console.log(`NEEDS CORRECTION: ${correctionCount}`);
  console.log(`TRULY AMBIGUOUS: ${ambiguousCount}`);

  // Group NEEDS CORRECTION by root cause for bulk approval.
  const correctionGroups = new Map<string, number>();
  for (const t of tiered) {
    if (t.tier !== "NEEDS CORRECTION") continue;
    const key = t.correction.split(" — ")[0];
    correctionGroups.set(key, (correctionGroups.get(key) ?? 0) + 1);
  }
  console.log(`\nNEEDS CORRECTION grouped by root cause:`);
  for (const [k, v] of [...correctionGroups.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  // Ambiguous (non-creation) summary
  const ambiguousByReason = new Map<string, number>();
  for (const r of ambiguousRows) {
    const bucket = r.reason.split(" — ")[0].split(" (")[0];
    ambiguousByReason.set(bucket, (ambiguousByReason.get(bucket) ?? 0) + 1);
  }

  // --- Build workbook ---
  const wb = XLSX.utils.book_new();

  function creationSheetRow(r: CreationRow, tier: string, correction: string, i: number) {
    return {
      "#": i + 2, Supplier: r.supplier, "Original Description": r.description, "Proposed Master Product Name": r.proposedName,
      Brand: r.brand, Concentration: r.concentration ?? "", "Size (ml)": r.sizeMl ?? "", "Product Form": r.productForm,
      Tester: r.isTester ? "Y" : "", "Gift Set": r.isGiftSet ? "Y" : "", Refill: r.isRefill ? "Y" : "",
      UPC: r.upc, EAN: r.ean, "Supplier Price": r.price, "Supplier Qty": r.quantity ?? "", "Identity Signature": r.signature,
      "Closest Existing Master Product": r.closestExisting, "Why Not An Exact Match": r.whyNotMatch,
      "Duplicate-Check Result": r.duplicateCheck, Flags: r.flags.join("; "), Tier: tier, "Proposed Correction / Reason": correction,
    };
  }

  const safeRows = tiered.filter((t) => t.tier === "SAFE TO CREATE").map((t, i) => creationSheetRow(t.r, t.tier, t.correction, i));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(safeRows), "SAFE TO CREATE");

  const correctionRows = tiered.filter((t) => t.tier === "NEEDS CORRECTION").map((t, i) => creationSheetRow(t.r, t.tier, t.correction, i));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(correctionRows), "NEEDS CORRECTION");

  const ambigCreationRows = tiered.filter((t) => t.tier === "TRULY AMBIGUOUS").map((t, i) => creationSheetRow(t.r, t.tier, t.correction, i));
  const ambiguousDetailData = ambiguousRows.map((r, i) => ({ "#": i + 2, Supplier: r.supplier, Description: r.description, Reason: r.reason }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([...ambigCreationRows, ...ambiguousDetailData]), "TRULY AMBIGUOUS");

  const linkSheetData = linkRows.map((r, i) => ({
    "#": i + 2, Supplier: r.supplier, "Original Description": r.description, "Supplier Price": r.price,
    "Supplier Qty": r.quantity ?? "", "Links To (ID)": r.targetId, "Links To (Name)": r.targetLabel,
    "Match Type": r.matchType, "Match Confidence": r.matchConfidence ?? "", "Compatibility Check": r.compatibilityCheck,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linkSheetData), "Existing Links (verified)");

  const withinBatchData = withinBatchDedupRows.map((r, i) => ({
    "#": i + 2, Supplier: r.supplier, "Original Description": r.description, "Supplier Price": r.price,
    "Supplier Qty": r.quantity ?? "", "Dedups Against (this batch's own proposal)": r.targetLabel,
    "Match Type": r.matchType, "Match Confidence": r.matchConfidence ?? "",
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(withinBatchData), "Within-Batch Dedup");

  const ambiguousSummaryData = [...ambiguousByReason.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ Reason: reason, Count: count }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ambiguousSummaryData), "Ambiguous Summary");

  const summarySheetData = [
    { Metric: "Report generated at", Value: new Date().toISOString() },
    { Metric: "Total unresolved offers examined", Value: creationRows.length + linkRows.length + withinBatchDedupRows.length + ambiguousRows.length + conflictRows.length + invalidCount.unsupported + invalidCount.other },
    { Metric: "SAFE TO CREATE", Value: safeCount },
    { Metric: "NEEDS CORRECTION", Value: correctionCount },
    { Metric: "TRULY AMBIGUOUS (creation candidates)", Value: ambiguousCount },
    { Metric: "TRULY AMBIGUOUS (needs_review/ineligible, non-creation)", Value: ambiguousRows.length },
    { Metric: "Genuine links to EXISTING catalog Master/real Products", Value: linkRows.length },
    { Metric: "Within-batch dedup links (two rows in this migration, same item)", Value: withinBatchDedupRows.length },
    { Metric: "Identity conflicts", Value: conflictRows.length },
    { Metric: "Unsupported merchandise (excluded)", Value: invalidCount.unsupported },
    { Metric: "Other invalid rows (excluded)", Value: invalidCount.other },
    { Metric: "Signature collisions among proposals", Value: [...bySignature.values()].filter((v) => v.length > 1).length },
    { Metric: "Pairwise real-matcher equivalence flags", Value: pairwiseFlagged },
    { Metric: "Repeated UPCs among proposals — compatible", Value: upcCompatible },
    { Metric: "Repeated UPCs among proposals — INCOMPATIBLE (flagged)", Value: upcIncompatible },
    { Metric: "Rows with residual supplier-logistics terms in identity (should be 0)", Value: tiered.filter((t) => t.r.flags.some((f) => f.startsWith("RESIDUAL LOGISTICS TERM"))).length },
    { Metric: "Existing-catalog links independently flagged as INCOMPATIBLE (target has extra distinguishing words)", Value: incompatibleLinks.length },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summarySheetData), "Summary");

  const outPath = path.resolve(__dirname, "..", "backups", `migration-proposal-report-v2-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`);
  XLSX.writeFile(wb, outPath);
  console.log(`\nReport written to: ${outPath}`);
}
main();
