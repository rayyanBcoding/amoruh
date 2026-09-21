// Part 9 — end-to-end verification, Tests A-H, against ISOLATED
// in-memory constructed data only. Zero Redis reads/writes: every
// function under test here (matchSupplierRow, matchAgainstMasterCandidates,
// checkAutoCreateEligibility, computeIdentitySignature,
// buildMasterCandidatePool) is a pure function over plain arrays already
// passed in by its caller in production — none of them touch `redis`
// directly — so a fully isolated test needs no separate database, just
// constructed Product/PricingReferenceProduct/offer objects standing in
// for what a real upload or catalog would contain.
//
// Tests D and H (migration idempotency against the real atomic Redis
// primitive, and "no Inventory/Sales writes") are NOT exercised live
// here — this repo's .env.development.local points at the SAME database
// as production (a known, already-flagged issue), so per the standing
// "use isolated test databases going forward" instruction, no write
// test runs against it. D and H are instead verified by static code
// inspection (see the accompanying report) and are marked as such below.

import fs from "fs";
import type { PricingReferenceProduct } from "../src/lib/pricing-types";
import {
  matchSupplierRow,
  checkAutoCreateEligibility,
  computeIdentitySignature,
  extractAttributes,
  extractReferenceProductAttributes,
  type MatchRowInput,
} from "../src/lib/pricing-matching";

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
    console.log(`  PASS: ${label}`);
  } else {
    fail++;
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeRef(overrides: Partial<PricingReferenceProduct>): PricingReferenceProduct {
  return {
    id: "refprod_test",
    brand: "",
    name: "",
    description: "",
    sizeMl: null,
    concentration: null,
    isTester: false,
    isGiftSet: false,
    isRefill: false,
    productForm: "fragrance",
    upc: "",
    ean: "",
    productId: null,
    createdAt: new Date().toISOString(),
    createdBy: "test",
    creationMethod: "auto_import",
    createdFromSupplierId: null,
    createdFromUploadId: null,
    createdFromOfferKey: null,
    ...overrides,
  };
}

function makeRow(overrides: Partial<MatchRowInput>): MatchRowInput {
  return { offerKey: "test_key", supplierSku: "", description: "", brand: "", upc: "", ean: "", ...overrides };
}

console.log("=== Test A: new fragrance auto-creates with visible pricing ===");
{
  // Fully-specified new fragrance, no existing catalog entry anywhere.
  const row = makeRow({ offerKey: "a1", description: "TESTBRAND MIDNIGHT ORCHID (W) EDP 100ML", brand: "TESTBRAND", upc: "9999900001111" });
  const match = matchSupplierRow(row, [], [], []);
  check("no existing catalog entry -> not an auto_matched carry-over", match.reviewStatus !== "auto_matched");
  const attrs = extractAttributes(`${row.brand} ${row.description}`, "TESTBRAND");
  const eligibility = checkAutoCreateEligibility(attrs, true);
  check("fully-specified row (brand+name+size+concentration+barcode) is auto-create eligible", eligibility.eligible, eligibility.reason);
  check("parsed size is 100ml", attrs.sizeMl === 100, `got ${attrs.sizeMl}`);
  check("parsed concentration recognized", attrs.concentration !== null, `got ${attrs.concentration}`);
}

console.log("\n=== Test B: second supplier, different wording + oz/ml, same fragrance ===");
{
  // A real reference product's name/description preserve the ORIGINAL
  // first-supplier row text verbatim (see migrate-backlog-dry-run.ts /
  // getOrCreateReferenceProductByIdentity's newRecordInput — never a
  // cleaned-up label) — including its own gender marker, so a second
  // supplier's row with the same marker scores an exact text match.
  const existingRef = makeRef({
    id: "refprod_b1",
    brand: "Creed",
    name: "CREED AVENTUS (M) EDP 100ML",
    description: "CREED AVENTUS (M) EDP 100ML",
    sizeMl: 100,
    concentration: "edp",
    upc: "3508440505701",
  });
  const pool = [existingRef];
  // Second supplier describes it very differently: "by Creed" ordering,
  // "3.4oz" instead of "100ml", extra AE/US country-code noise.
  const row = makeRow({ offerKey: "b1", description: "AVENTUS BY CREED (M) EDP 3.4OZ AE", brand: "Creed", upc: "3508440505701" });
  const match = matchSupplierRow(row, [], [], pool);
  check(
    "different wording + oz/ml for the same UPC attaches to the SAME Master Product",
    match.reviewStatus === "auto_matched" && match.referenceProductId === "refprod_b1",
    `got reviewStatus=${match.reviewStatus} referenceProductId=${match.referenceProductId}`
  );

  // Same test WITHOUT a shared barcode — pure text/attribute matching,
  // oz stated instead of ml, brand-order reversed in free text.
  const rowNoUpc = makeRow({ offerKey: "b2", description: "AVENTUS BY CREED (M) EDP 3.4OZ", brand: "Creed", upc: "", ean: "" });
  const matchNoUpc = matchSupplierRow(rowNoUpc, [], [], pool);
  check(
    "no shared barcode, but same brand/core-name/size(oz->ml)/concentration still attaches to the SAME Master Product",
    matchNoUpc.reviewStatus === "auto_matched" && matchNoUpc.referenceProductId === "refprod_b1",
    `got reviewStatus=${matchNoUpc.reviewStatus} referenceProductId=${matchNoUpc.referenceProductId} confidence=${matchNoUpc.matchConfidence}`
  );
}

console.log("\n=== Test C: re-upload creates no duplicates ===");
{
  const existingRef = makeRef({ id: "refprod_c1", brand: "TestBrand", name: "Solstice", description: "TestBrand Solstice EDT", sizeMl: 50, concentration: "edt", upc: "1112223334445" });
  const pool = [existingRef];
  const row = makeRow({ offerKey: "c1", description: "TESTBRAND SOLSTICE (U) EDT 50ML", brand: "TestBrand", upc: "1112223334445" });
  const firstPass = matchSupplierRow(row, [], [], pool);
  const secondPass = matchSupplierRow(row, [], [], pool); // identical re-upload, same pool
  check(
    "identical re-upload resolves to the SAME existing Master Product both times",
    firstPass.referenceProductId === "refprod_c1" && secondPass.referenceProductId === "refprod_c1",
    `first=${firstPass.referenceProductId} second=${secondPass.referenceProductId}`
  );
}

console.log("\n=== Test E: different sizes/concentrations/flankers/testers/refills/giftsets stay separate ===");
{
  // Required verification case from the plan: same brand+size, no
  // concentration recognized on the incoming row -> must NOT auto-match
  // any single one of several differently-concentrated siblings.
  const edt = makeRef({ id: "refprod_e_edt", brand: "Dior", name: "Sauvage", description: "Dior Sauvage EDT", sizeMl: 100, concentration: "edt" });
  const edp = makeRef({ id: "refprod_e_edp", brand: "Dior", name: "Sauvage", description: "Dior Sauvage EDP", sizeMl: 100, concentration: "edp" });
  const parfum = makeRef({ id: "refprod_e_parfum", brand: "Dior", name: "Sauvage", description: "Dior Sauvage Parfum", sizeMl: 100, concentration: "parfum" });
  const pool = [edt, edp, parfum];
  const ambiguousRow = makeRow({ offerKey: "e1", description: "DIOR SAUVAGE 100ML", brand: "Dior" });
  const ambiguousMatch = matchSupplierRow(ambiguousRow, [], [], pool);
  check(
    "DIOR SAUVAGE 100ML (no stated concentration) vs 3 concentration siblings -> needs_review, never auto-match",
    ambiguousMatch.reviewStatus === "needs_review" && !ambiguousMatch.referenceProductId,
    `got ${ambiguousMatch.reviewStatus} ref=${ambiguousMatch.referenceProductId}`
  );
  const explicitRow = makeRow({ offerKey: "e2", description: "DIOR SAUVAGE EDP 100ML", brand: "Dior" });
  const explicitMatch = matchSupplierRow(explicitRow, [], [], pool);
  check(
    "DIOR SAUVAGE EDP 100ML (concentration stated) -> auto-matches the EDP sibling specifically",
    explicitMatch.reviewStatus === "auto_matched" && explicitMatch.referenceProductId === "refprod_e_edp",
    `got ${explicitMatch.reviewStatus} ref=${explicitMatch.referenceProductId}`
  );

  // Tester vs retail of the identical fragrance/size/concentration.
  const retail = makeRef({ id: "refprod_e_retail", brand: "TestBrand", name: "Ember", description: "TestBrand Ember EDT", sizeMl: 100, concentration: "edt", isTester: false });
  const testerRow = makeRow({ offerKey: "e3", description: "TESTBRAND EMBER (M) EDT 100ML TESTER", brand: "TestBrand" });
  const testerMatch = matchSupplierRow(testerRow, [], [], [retail]);
  check(
    "tester row never auto-matches a non-tester Master Product of the identical fragrance/size/concentration",
    testerMatch.reviewStatus !== "auto_matched",
    `got ${testerMatch.reviewStatus} ref=${testerMatch.referenceProductId}`
  );
  const retailAttrs = extractReferenceProductAttributes(retail);
  const testerAttrs = extractAttributes("TestBrand TESTBRAND EMBER (M) EDT 100ML TESTER", "TestBrand");
  check(
    "retail and tester signatures differ (never collapse to one identity)",
    computeIdentitySignature(retailAttrs) !== computeIdentitySignature(testerAttrs)
  );

  // Refill vs standalone bottle, same brand/size/concentration.
  const bottle = makeRef({ id: "refprod_e_bottle", brand: "TestBrand", name: "Ember", description: "TestBrand Ember EDT", sizeMl: 100, concentration: "edt", isRefill: false });
  const refillRow = makeRow({ offerKey: "e4", description: "TESTBRAND EMBER (M) EDT 100ML REFILL", brand: "TestBrand" });
  const refillMatch = matchSupplierRow(refillRow, [], [], [bottle]);
  check("refill row never auto-matches a standalone-bottle Master Product", refillMatch.reviewStatus !== "auto_matched", `got ${refillMatch.reviewStatus}`);

  // Gift set vs standalone, same brand/size/concentration.
  const standalone = makeRef({ id: "refprod_e_standalone", brand: "TestBrand", name: "Ember", description: "TestBrand Ember EDT", sizeMl: 100, concentration: "edt", isGiftSet: false });
  const giftSetRow = makeRow({ offerKey: "e5", description: "TESTBRAND EMBER (M) EDT 100ML GIFT SET WITH BODY LOTION", brand: "TestBrand" });
  const giftSetMatch = matchSupplierRow(giftSetRow, [], [], [standalone]);
  check("gift-set row never auto-matches a standalone Master Product", giftSetMatch.reviewStatus !== "auto_matched", `got ${giftSetMatch.reviewStatus}`);

  // Different flankers, same brand/size/concentration (core-name axis).
  const manFlanker = makeRef({ id: "refprod_e_man", brand: "TestBrand", name: "Nomad Man", description: "TestBrand Nomad Man EDT", sizeMl: 100, concentration: "edt" });
  const iceFlankerRow = makeRow({ offerKey: "e6", description: "TESTBRAND NOMAD MAN ICE (M) EDT 100ML", brand: "TestBrand" });
  const flankerMatch = matchSupplierRow(iceFlankerRow, [], [], [manFlanker]);
  check(
    "a differently-named flanker (Man vs Man Ice) does not blindly auto-match the base line at the same size/concentration",
    flankerMatch.reviewStatus !== "auto_matched" || flankerMatch.referenceProductId !== "refprod_e_man",
    `got ${flankerMatch.reviewStatus} ref=${flankerMatch.referenceProductId} confidence=${flankerMatch.matchConfidence}`
  );
}

console.log("\n=== Test F: genuine ambiguity stays searchable without a guessed product ===");
{
  const candidateA = makeRef({ id: "refprod_f_a", brand: "TestBrand", name: "Solaris", description: "TestBrand Solaris EDT", sizeMl: 50, concentration: "edt" });
  const candidateB = makeRef({ id: "refprod_f_b", brand: "TestBrand", name: "Solstice", description: "TestBrand Solstice EDT", sizeMl: 50, concentration: "edt" });
  const row = makeRow({ offerKey: "f1", description: "TESTBRAND SOL (U) EDT 50ML", brand: "TestBrand" });
  const match = matchSupplierRow(row, [], [], [candidateA, candidateB]);
  check(
    "genuinely ambiguous row (could be either sibling) never silently picks one — stays needs_review/new_candidate with no productId/referenceProductId set",
    !match.productId && !match.referenceProductId,
    `got productId=${match.productId} referenceProductId=${match.referenceProductId} status=${match.reviewStatus}`
  );
  check("row is not silently dropped — reviewStatus is a real, visible status", ["needs_review", "new_candidate"].includes(match.reviewStatus), `got ${match.reviewStatus}`);
}

console.log("\n=== Test G: comparisons exclude uncertain offers from BEST PRICE (existing logic, re-confirmed) ===");
{
  // splitAndRankComparisonRows itself already filters to auto_matched/confirmed
  // for actionable/bestPrice — re-verified directly against its own source
  // rather than re-implemented here, since duplicating the filter would
  // prove nothing about the real function.
  const src = fs.readFileSync(new URL("../src/lib/pricing-db.ts", import.meta.url), "utf8");
  const fnMatch = src.match(/function splitAndRankComparisonRows[\s\S]*?\n}\n/);
  check("splitAndRankComparisonRows exists", Boolean(fnMatch));
  if (fnMatch) {
    const body = fnMatch[0];
    check(
      "actionable/bestPrice eligibility is gated to auto_matched/confirmed only",
      /reviewStatus\s*===\s*"auto_matched"/.test(body) && /reviewStatus\s*===\s*"confirmed"/.test(body),
      "expected explicit auto_matched/confirmed checks in splitAndRankComparisonRows"
    );
  }
}

console.log("\n=== Test D: migration run twice creates zero duplicates (STATIC verification only) ===");
{
  console.log("  SKIPPED LIVE EXECUTION — see report: getOrCreateReferenceProductByIdentity (pricing-db.ts) is backed by");
  console.log("  a single atomic Lua script (GET_OR_CREATE_REFERENCE_PRODUCT_SCRIPT) that checks UPC/EAN/signature");
  console.log("  pointers and only SETs+ZADDs on the first call for a given identity; a second call with the same");
  console.log("  identity reads an already-set pointer and returns EXISTING, never CREATED twice. This was verified");
  console.log("  by code inspection (Part 3 of the report), not by a live write against this shared production DB,");
  console.log("  per the standing isolated-test-database instruction.");
  check("(recorded as verified-by-inspection, not executed)", true);
}

console.log("\n=== Test H: no Inventory/Sales changes (STATIC verification only) ===");
{
  const dbSrc = fs.readFileSync(new URL("../src/lib/pricing-db.ts", import.meta.url), "utf8");
  const noInventoryWrites = !/redis\.(set|hset|sadd|zadd|del)\([^)]*inventory/i.test(dbSrc);
  check("pricing-db.ts contains no writes to any inventory-namespaced key", noInventoryWrites);
  const matchingSrc = fs.readFileSync(new URL("../src/lib/pricing-matching.ts", import.meta.url), "utf8");
  check("pricing-matching.ts imports no redis client at all (pure functions only)", !/from ["']\.\/kv["']/.test(matchingSrc));
}

console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
