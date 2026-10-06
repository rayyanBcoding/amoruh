// READ-ONLY comprehensive audit of every currently-unresolved supplier
// offer, against the CURRENT (post-migration) production catalog.
// Re-runs the real matching code fresh for every row -- the stored
// reviewStatus reflects each offer's LAST real processing pass, which
// for most of these rows predates this session's parsing fixes (the
// migration only writes back offers it successfully resolves; a row
// that stayed ambiguous keeps whatever state its own last supplier
// upload left it in). "Why is this unresolved" must be answered from a
// fresh decision, not a stale label.
import * as XLSX from "xlsx";
import path from "path";
import { getSuppliers } from "../src/lib/intake-db";
import { getCommittedOffers, getAllReferenceProducts, getAliasesForSupplier, getOffersByReferenceProduct } from "../src/lib/pricing-db";
import { getProducts } from "../src/lib/db";
import {
  extractAttributes,
  checkAutoCreateEligibility,
  isUnsupportedMerchandise,
  isValidProductRow,
  matchSupplierRow,
  resolveEffectiveBrand,
  buildBrandBucketedPool,
  buildMasterCandidatePool,
  narrowPoolForRow,
  scoreStructuredMatch,
  isPlausibleBarcode,
  type StructuredAttributes,
} from "../src/lib/pricing-matching";
import type { PricingReferenceProduct, SupplierOfferCurrent } from "../src/lib/pricing-types";
import type { Product } from "../src/lib/types";

const UNRESOLVED_STATUSES = new Set(["new_candidate", "needs_review", "alias_conflict", "barcode_conflict"]);

type Category =
  | "A_missing_brand" | "B_missing_size" | "C_missing_concentration" | "D_name_unidentifiable"
  | "E_multiple_candidates" | "F_upc_ean_alias_conflict" | "G_form_tester_giftset_uncertain"
  | "H_logistics_confusion" | "I_matching_logic_gap" | "J_other_unsupported";

interface AuditRow {
  supplier: string; supplierId: string; offerKey: string; description: string; brand: string;
  upc: string; ean: string; supplierSku: string; price: number; quantity: number | null;
  parsedBrand: string; parsedName: string; sizeMl: number | null; concentration: string | null;
  productForm: string; isTester: boolean; isGiftSet: boolean; isRefill: boolean;
  storedReviewStatus: string; storedMatchType: string; storedReferenceProductId: string | null; storedProductId: string | null;
  freshReviewStatus: string; freshMatchType: string; freshCandidateId: string | null;
  category: Category; reasonDetail: string; contributingIssues: string[];
  existsAlready: "exact_match_not_linked" | "genuinely_new" | "uncertain" | "unsupported";
  closestCandidateLabel: string; closestCandidateScore: number | null;
  action: "AUTO_FIXABLE" | "NEEDS_SUPPLIER_INFO" | "NEEDS_OUR_DECISION";
  actionEvidence: string;
}

async function main() {
  const suppliers = await getSuppliers();
  const products: Product[] = await getProducts();
  const referenceProducts: PricingReferenceProduct[] = await getAllReferenceProducts();
  const pool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));
  console.log(`Current Master Catalog: ${referenceProducts.length} reference products, ${products.length} real products.`);

  const rows: AuditRow[] = [];
  let totalChecked = 0;
  let processed = 0;

  for (const s of suppliers) {
    const [offers, aliases] = await Promise.all([getCommittedOffers(s.id), getAliasesForSupplier(s.id)]);
    const aliasByOfferKey = new Map(aliases.map((a) => [a.offerKey, a]));
    const unresolved = Object.values(offers).filter((o) => o.currentlyListed !== false && UNRESOLVED_STATUSES.has(o.reviewStatus));
    totalChecked += unresolved.length;
    console.log(`[${s.name}] ${unresolved.length} unresolved offers (stored status), re-checking fresh...`);

    for (const o of unresolved) {
      const row = { offerKey: o.offerKey, supplierSku: o.supplierSku, description: o.description, brand: o.brand, upc: o.upc, ean: o.ean };
      const effectiveBrand = resolveEffectiveBrand(row, products, referenceProducts);
      const attrs = extractAttributes(`${o.brand} ${o.description}`, effectiveBrand);

      let category: Category = "J_other_unsupported";
      let reasonDetail = "";
      const contributingIssues: string[] = [];
      let existsAlready: AuditRow["existsAlready"] = "uncertain";
      let closestLabel = "";
      let closestScore: number | null = null;
      let freshReviewStatus = o.reviewStatus;
      let freshMatchType = o.matchType;
      let freshCandidateId: string | null = o.candidateReferenceProductId ?? o.candidateProductId ?? null;
      let action: AuditRow["action"] = "NEEDS_OUR_DECISION";
      let actionEvidence = "";

      // Invalid / unsupported merchandise -- highest priority, doesn't
      // need a fresh match at all (isValidProductRow already excludes it).
      if (!isValidProductRow(row)) {
        category = "J_other_unsupported";
        reasonDetail = isUnsupportedMerchandise(o.description) ? "unsupported merchandise (packaging/empty box/bag/sleeve, not a fragrance)" : "invalid/non-product row (no real product content)";
        existsAlready = "unsupported";
        action = "AUTO_FIXABLE";
        actionEvidence = "Already correctly excluded from creation by isValidProductRow — no code change needed, this row should simply stay excluded permanently.";
      } else if (o.reviewStatus === "alias_conflict") {
        const alias = aliasByOfferKey.get(o.offerKey);
        category = "F_upc_ean_alias_conflict";
        reasonDetail = alias
          ? `learned alias points at productId=${alias.productId} (source=${alias.source}, created=${alias.createdAt}) but the offer's current barcode/attributes no longer agree`
          : "alias_conflict status but no matching learned alias record found — investigate directly";
        contributingIssues.push("alias_conflict");
        existsAlready = "uncertain";
        action = "NEEDS_OUR_DECISION";
        actionEvidence = "Per standing instruction, aliases are never auto-deleted or overwritten — every alias_conflict needs a human to confirm whether the alias or the current row is correct.";
      } else if (o.reviewStatus === "barcode_conflict") {
        category = "F_upc_ean_alias_conflict";
        reasonDetail = "exact barcode match exists but the row's own text is too dissimilar to trust blindly (barcode-conflict text floor not cleared)";
        contributingIssues.push("barcode_conflict");
        action = "NEEDS_OUR_DECISION";
        actionEvidence = "A barcode collision with mismatched text could mean a supplier data error OR two genuinely different products sharing a reused/mistyped barcode — needs a human to inspect both sides.";
      } else {
        // needs_review or new_candidate -- re-run the REAL matcher fresh.
        const freshMatch = matchSupplierRow(row, products, [], referenceProducts, pool);
        freshReviewStatus = freshMatch.reviewStatus;
        freshMatchType = freshMatch.matchType;
        freshCandidateId = freshMatch.candidateReferenceProductId ?? freshMatch.candidateProductId ?? null;

        if (freshMatch.reviewStatus === "auto_matched" && (freshMatch.referenceProductId || freshMatch.productId)) {
          // The CURRENT catalog (post-migration) now actually contains
          // a match this row's stale stored status doesn't reflect.
          category = "I_matching_logic_gap";
          reasonDetail = "the current catalog now contains a real match for this row (likely created by this session's own migration) — its stored status simply predates that; a normal re-process would resolve it.";
          existsAlready = "exact_match_not_linked";
          const targetId = freshMatch.referenceProductId ?? freshMatch.productId!;
          const targetRef = referenceProducts.find((rp) => rp.id === targetId);
          closestLabel = targetRef ? `${targetRef.brand} ${targetRef.name}` : targetId;
          closestScore = freshMatch.matchConfidence;
          action = "AUTO_FIXABLE";
          actionEvidence = `matchSupplierRow already resolves this row to ${targetId} with confidence ${freshMatch.matchConfidence} on a fresh check — safe to link via the exact same get-or-create/link primitives already used, no new logic needed.`;
        } else if (freshMatch.reviewStatus === "barcode_conflict") {
          category = "F_upc_ean_alias_conflict";
          reasonDetail = "fresh check: exact barcode match exists but text is too dissimilar to trust";
          action = "NEEDS_OUR_DECISION";
          actionEvidence = "Same barcode-vs-text disagreement as a stored barcode_conflict — needs human judgment.";
        } else if (freshMatch.reviewStatus === "needs_review") {
          const candidates = freshMatch.competingCandidates ?? (freshMatch.candidateReferenceProductId || freshMatch.candidateProductId ? [{ productId: freshMatch.candidateProductId, referenceProductId: freshMatch.candidateReferenceProductId }] : []);
          if (candidates.length > 1) {
            // Concentration is only the discriminating axis for actual
            // fragrance rows -- checkAutoCreateEligibility itself only
            // treats a null concentration as blocking when
            // productForm==="fragrance" (pricing-matching.ts:971). A
            // non-fragrance row (body spray, deodorant, etc.) legitimately
            // has no concentration; attributing its ambiguity to "missing
            // concentration" would be wrong -- the real story is that
            // multiple candidates remain plausible on text/edition alone.
            const concentrationIsRelevantAxis = attrs.productForm === "fragrance" && attrs.concentration === null;
            category = concentrationIsRelevantAxis ? "C_missing_concentration" : "E_multiple_candidates";
            reasonDetail = concentrationIsRelevantAxis
              ? `row doesn't state a concentration and ${candidates.length} existing candidates disagree on concentration — matcher correctly refuses to guess`
              : `${candidates.length} existing candidates remain plausible after hard gates (product form: ${attrs.productForm}); text/edition similarity too close to pick one safely`;
            contributingIssues.push("multiple_candidates");
          } else if (candidates.length === 1) {
            category = "D_name_unidentifiable";
            reasonDetail = "exactly one candidate passed hard gates but text similarity is in the review band, not confident enough to auto-match — likely a genuinely different flanker/edition, or a wording gap";
          } else {
            category = "D_name_unidentifiable";
            reasonDetail = "needs_review with no specific candidate recorded — investigate this row directly";
          }
          existsAlready = candidates.length > 0 ? "uncertain" : "genuinely_new";
          if (candidates.length > 0) {
            const cid = candidates[0].referenceProductId ?? candidates[0].productId;
            const cRef = referenceProducts.find((rp) => rp.id === cid);
            closestLabel = cRef ? `${cRef.brand} ${cRef.name}` : cid ?? "";
            const cAttrs = cRef ? extractAttributes(`${cRef.brand} ${cRef.name} ${cRef.description}`, cRef.brand) : null;
            if (cAttrs) closestScore = scoreStructuredMatch(attrs, cAttrs).confidence;
          }
          action = "NEEDS_OUR_DECISION";
          actionEvidence = "Genuine ambiguity between real candidates — a human needs to pick the right one or confirm this is a new product.";
        } else {
          // new_candidate outcome, or no_match -- check WHY it's not eligible for auto-create.
          const plausibleUpc = isPlausibleBarcode(o.upc.trim().toUpperCase()) ? o.upc.trim() : "";
          const plausibleEan = isPlausibleBarcode(o.ean.trim().toUpperCase()) ? o.ean.trim() : "";
          const eligibility = checkAutoCreateEligibility(attrs, Boolean(plausibleUpc || plausibleEan));

          if (!eligibility.eligible) {
            if (eligibility.reason?.includes("brand not recognized")) {
              category = "A_missing_brand";
              reasonDetail = eligibility.reason;
              action = "AUTO_FIXABLE";
              actionEvidence = `Structurally complete except brand — this is exactly the 69-item "held for brand assignment" pattern from the migration; once a human confirms the brand name once, it auto-creates safely via the existing barcode-anchored eligibility path.`;
            } else if (eligibility.reason?.includes("no fragrance/product-line name")) {
              category = "D_name_unidentifiable";
              reasonDetail = eligibility.reason;
              action = "NEEDS_SUPPLIER_INFO";
              actionEvidence = "No usable product name survives after stripping brand/size/concentration — the supplier's own description doesn't contain enough information to identify a specific fragrance.";
            } else if (eligibility.reason?.includes("size not parsed")) {
              category = "B_missing_size";
              reasonDetail = eligibility.reason;
              action = "NEEDS_SUPPLIER_INFO";
              actionEvidence = "No size could be parsed from the row's own text at all — needs the supplier's actual size, not guessable from existing data.";
            } else if (eligibility.reason?.includes("concentration ambiguous")) {
              category = "C_missing_concentration";
              reasonDetail = eligibility.reason;
              action = "NEEDS_SUPPLIER_INFO";
              actionEvidence = "Row doesn't state EDT/EDP/Parfum/etc. and this fragrance has no existing catalog entry to disambiguate against — needs the supplier's actual concentration.";
            } else {
              category = "J_other_unsupported";
              reasonDetail = eligibility.reason ?? "ineligible for an unspecified structural reason";
              action = "NEEDS_SUPPLIER_INFO";
              actionEvidence = "See reason detail.";
            }
          } else {
            // Eligible, AND matchSupplierRow found zero candidates in
            // the full current pool (freshMatch.reviewStatus ===
            // "new_candidate" with no competing candidates) -- this is
            // structurally the exact same "brand+name+size+concentration
            // all resolved, no existing match" shape the just-executed
            // migration used to safely create its 1,769 new Master
            // Products. It is not a matching-logic bug; it's simply a
            // row no processing pass has created yet. Treated as
            // AUTO_FIXABLE, but the same duplicate-signature safety
            // check the executed migration used must be re-run at
            // execution time -- this audit does not re-verify it here.
            category = "I_matching_logic_gap";
            reasonDetail = "row is structurally eligible for auto-creation (brand+name+size+concentration-or-form all resolved) and matchSupplierRow finds zero existing candidates -- but it is still sitting as new_candidate rather than created, meaning no auto-creation pass has processed it since it became eligible.";
            existsAlready = "genuinely_new";
            action = "AUTO_FIXABLE";
            actionEvidence = "Same eligibility criteria (checkAutoCreateEligibility) and zero-candidate outcome as the 1,769 Master Products already created by the executed migration -- safe to create via the identical get-or-create primitive, subject to the same duplicate-signature/UPC/EAN collision check run before any real creation.";
          }
        }

        // Secondary signal checks, regardless of primary category:
        if (attrs.isGiftSet || attrs.isTester || attrs.isRefill) contributingIssues.push(`form flags: tester=${attrs.isTester} giftSet=${attrs.isGiftSet} refill=${attrs.isRefill}`);
        if (/bybox|pcs\b/i.test(o.description)) contributingIssues.push("logistics wording present (already stripped from identity, informational only)");
        // classifyProductForm() (pricing-matching.ts) only recognizes:
        // body_lotion, aftershave, body_spray, shower_oil, shower_gel,
        // moisturizer, deodorant, soap, candle. Anything else -- body
        // mist, hair mist, fragrance mist, room/linen spray, perfume
        // concentrate, and non-fragrance cosmetics/accessories (cream,
        // foundation, mascara, bag, case) -- silently defaults to
        // "fragrance" and then wrongly requires a stated concentration.
        // This is a genuine, confirmed production code gap (verified
        // directly against the pattern list, not inferred), distinct
        // from a row genuinely lacking a stated EDT/EDP/Parfum.
        const unclassifiedNonFragranceForm = /\b(body\s*mist|hair\s*mist|fragrance\s*mist|linen\s*spray|room\s*spray|perfume\s*concentrate|body\s*souffle|body\s*wash|body\s*scrub|body\s*cream|body\s*butter|face\s*cream|hand\s*cream|foot\s*(cream|treatment)|foundation|mascara|lipstick|eyeliner|eye\s*(shadow|pencil|definer)|cream\s*color|primer|powder|bronzer|blush|lip\s*(gloss|oil|liner|balm)|highlighter|concealer|kajal|brow|solid\s*perfume|cleansing\s*gel|illuminating\s*cream|mattifying|tinted|sleep\s*mask)\b/i;
        if (attrs.productForm === "fragrance" && unclassifiedNonFragranceForm.test(o.description)) {
          contributingIssues.push("PRODUCT-FORM GAP: description matches a non-fragrance keyword not in PRODUCT_FORM_PATTERNS (pricing-matching.ts) — classifyProductForm() still returned 'fragrance', which can wrongly force a concentration requirement or wrongly gate against real fragrance candidates.");
        }
      }

      rows.push({
        supplier: s.name, supplierId: s.id, offerKey: o.offerKey, description: o.description, brand: o.brand,
        upc: o.upc, ean: o.ean, supplierSku: o.supplierSku, price: o.price, quantity: o.quantity,
        parsedBrand: effectiveBrand, parsedName: attrs.coreNameTokens.join(" "), sizeMl: attrs.sizeMl, concentration: attrs.concentration,
        productForm: attrs.productForm, isTester: attrs.isTester, isGiftSet: attrs.isGiftSet, isRefill: attrs.isRefill,
        storedReviewStatus: o.reviewStatus, storedMatchType: o.matchType, storedReferenceProductId: o.referenceProductId, storedProductId: o.productId,
        freshReviewStatus, freshMatchType, freshCandidateId,
        category, reasonDetail, contributingIssues, existsAlready, closestCandidateLabel: closestLabel, closestCandidateScore: closestScore,
        action, actionEvidence,
      });
      processed++;
      if (processed % 200 === 0) console.log(`  ...${processed} processed`);
    }
  }

  console.log(`\nTotal unresolved offers found (fresh, current): ${totalChecked}`);
  console.log(`Total processed: ${processed}`);

  fs_writeReport(rows, referenceProducts, products, pool);
}

async function fs_writeReport(rows: AuditRow[], referenceProducts: PricingReferenceProduct[], products: Product[], pool: ReturnType<typeof buildBrandBucketedPool>) {
  const fs = await import("fs");
  const outPath = path.resolve(__dirname, "..", "backups", `unresolved-offers-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ rows, generatedAt: new Date().toISOString() }, null, 2));
  console.log(`\nRaw audit data written to: ${outPath}`);

  // Category reconciliation
  const byCategory = new Map<string, number>();
  for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
  console.log("\n=== Category breakdown ===");
  for (const [cat, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${cat}: ${count}`);
  console.log(`  TOTAL: ${rows.length}`);

  const byAction = new Map<string, number>();
  for (const r of rows) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
  console.log("\n=== Action breakdown ===");
  for (const [a, count] of byAction.entries()) console.log(`  ${a}: ${count}`);

  const bySupplier = new Map<string, number>();
  for (const r of rows) bySupplier.set(r.supplier, (bySupplier.get(r.supplier) ?? 0) + 1);
  console.log("\n=== By supplier ===");
  for (const [s, count] of bySupplier.entries()) console.log(`  ${s}: ${count}`);
}

main();
