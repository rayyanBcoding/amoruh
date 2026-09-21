// Real-Redis integration test for the AMORUH migration primitives.
//
// SAFETY MODEL (read before running):
//   1. Requires ISOLATED_TEST_REDIS_URL and ISOLATED_TEST_REDIS_TOKEN —
//      dedicated env var names, NEVER the app's own AMORUH_REDIS_URL/
//      AMORUH_REDIS_TOKEN. The script never reads those two names from
//      the ambient environment for any purpose other than the
//      not-production comparison below, and never assigns a production
//      value to the client it actually connects with.
//   2. Fails IMMEDIATELY (before importing anything from src/lib, before
//      any network call) if either required env var is missing or empty.
//   3. Reads the real production Redis URL directly out of
//      .env.development.local ON DISK (never loaded into process.env,
//      never used to build a client) purely to prove, by string
//      inequality, that ISOLATED_TEST_REDIS_URL is NOT the production
//      endpoint. If that file can't be found or parsed, the script
//      fails closed rather than skipping the check.
//   4. Never logs a token value, isolated or production — only host-
//      names are ever printed.
//   5. Only after both checks pass does it map ISOLATED_TEST_REDIS_URL/
//      TOKEN onto the AMORUH_REDIS_URL/TOKEN names that src/lib/kv.ts
//      actually reads — so every real function under test
//      (pricing-db.ts, intake-db.ts) transparently operates against the
//      isolated database, with zero application-code changes.
//
// HOW TO GET AN ISOLATED DATABASE:
//   Option A (fastest, no signup, 3-day TTL):
//     curl -X POST https://upstash.com/start-redis
//   This returns an Endpoint + Token for a brand-new, empty Redis
//   database, isolated from production. If you want it to persist
//   longer than 3 days, open the "console URL" the response gives you
//   and click Claim.
//
//   Option B: create your own free Upstash database at
//   https://console.upstash.com and copy its REST URL/token.
//
// HOW TO RUN:
//   ISOLATED_TEST_REDIS_URL="https://your-isolated-db.upstash.io" \
//   ISOLATED_TEST_REDIS_TOKEN="your-isolated-db-token" \
//   npx tsx scripts/test-migration-isolated-redis.ts
//
// Never paste real credentials into chat, a commit, or any log —
// export them as local shell env vars for this one command only.

import fs from "fs";
import path from "path";

function fail(message: string): never {
  console.error(`\nREFUSING TO RUN: ${message}\n`);
  process.exit(1);
}

const isolatedUrl = process.env.ISOLATED_TEST_REDIS_URL?.trim() ?? "";
const isolatedToken = process.env.ISOLATED_TEST_REDIS_TOKEN?.trim() ?? "";

if (!isolatedUrl || !isolatedToken) {
  fail(
    "ISOLATED_TEST_REDIS_URL and ISOLATED_TEST_REDIS_TOKEN must both be set.\n" +
      "  This script NEVER falls back to the app's AMORUH_REDIS_URL/AMORUH_REDIS_TOKEN —\n" +
      "  see the header comment in this file for how to get an isolated database in one command."
  );
}

// Read production's real URL directly off disk, for comparison ONLY —
// never loaded into process.env, never used to build any client.
const prodEnvPath = path.resolve(__dirname, "..", ".env.development.local");
if (!fs.existsSync(prodEnvPath)) {
  fail(`Cannot verify isolation — ${prodEnvPath} was not found, so the not-production check cannot run. Failing closed.`);
}
const prodEnvText = fs.readFileSync(prodEnvPath, "utf8");
const prodUrlMatch = prodEnvText.match(/^AMORUH_REDIS_URL\s*=\s*"?([^"\n]+)"?\s*$/m);
const prodTokenMatch = prodEnvText.match(/^AMORUH_REDIS_TOKEN\s*=\s*"?([^"\n]+)"?\s*$/m);
if (!prodUrlMatch) {
  fail(`Cannot verify isolation — AMORUH_REDIS_URL not found in ${prodEnvPath}. Failing closed.`);
}
const prodUrl = prodUrlMatch[1].trim();
const prodToken = prodTokenMatch?.[1]?.trim() ?? "";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url; // fall back to raw string comparison if not a parseable URL
  }
}

if (hostOf(isolatedUrl) === hostOf(prodUrl)) {
  fail(
    `ISOLATED_TEST_REDIS_URL points at the SAME host as production (${hostOf(prodUrl)}).\n` +
      "  This is exactly the mistake this check exists to catch. Use a genuinely separate database."
  );
}
if (isolatedToken.length > 0 && prodToken.length > 0 && isolatedToken === prodToken) {
  fail("ISOLATED_TEST_REDIS_TOKEN matches the production token even though the URL differs. Refusing to proceed.");
}
console.log(`Isolation check passed: isolated host="${hostOf(isolatedUrl)}" differs from production host="${hostOf(prodUrl)}".`);
console.log("(Tokens are never printed, isolated or production.)");

// Only now — after both checks pass — do we point the app's OWN env var
// names at the isolated credentials. This is the ONLY place either var
// is ever assigned in this script, and it is never assigned a
// production value.
process.env.AMORUH_REDIS_URL = isolatedUrl;
process.env.AMORUH_REDIS_TOKEN = isolatedToken;

async function main() {
  const { getOrCreateSupplier, getSuppliers } = await import("../src/lib/intake-db");
  const {
    writeCandidateGeneration,
    commitGeneration,
    getCommittedOffers,
    getCurrentGenerationId,
    getOrCreateReferenceProductByIdentity,
    getAllReferenceProducts,
    getReferenceProduct,
    getOffersByReferenceProduct,
    bulkUpdateOffers,
  } = await import("../src/lib/pricing-db");
  const { redis } = await import("../src/lib/kv");
  const { extractAttributes, computeIdentitySignature, matchSupplierRow, checkAutoCreateEligibility } = await import(
    "../src/lib/pricing-matching"
  );
  type SupplierOfferCurrent = import("../src/lib/pricing-types").SupplierOfferCurrent;
  type SupplierPriceUpload = import("../src/lib/pricing-types").SupplierPriceUpload;

  let pass = 0;
  let fail_ = 0;
  const results: { label: string; status: "PASS" | "FAIL"; detail?: string }[] = [];
  function check(label: string, condition: boolean, detail?: string) {
    if (condition) {
      pass++;
      results.push({ label, status: "PASS" });
      console.log(`  PASS: ${label}`);
    } else {
      fail_++;
      results.push({ label, status: "FAIL", detail });
      console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }

  const pingKey = "amoruh_test:isolation_sanity_check";
  await redis.set(pingKey, "isolated");
  check("connected to the isolated Redis instance (write/read round-trip)", (await redis.get(pingKey)) === "isolated");
  const existingSuppliersBefore = await getSuppliers();
  check(
    "isolated DB starts with a small/empty supplier set (never touching production's real supplier list)",
    existingSuppliersBefore.length < 5,
    `found ${existingSuppliersBefore.length} suppliers — if this is large, this is NOT actually isolated`
  );

  const nowIso = new Date().toISOString();
  // Unique per invocation so this test is safely re-runnable against a
  // non-empty (but still isolated) database without colliding with a
  // prior run's leftover suppliers/identities — get-or-create would
  // otherwise correctly (but confusingly, for this test's own fixed
  // assertions) return "existing" for a UPC a previous run already created.
  const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // Alphanumeric-only variant for embedding INSIDE fragrance names —
  // computeIdentitySignature is keyed off brand+core-name+size+
  // concentration etc., not the UPC, so a fixed product name (e.g.
  // "TESTBRAND ISOLATED NOVA") collides with a PRIOR run's already-
  // created record by signature alone even when the UPC is unique this
  // time. The core name itself needs a per-run token too.
  const RUN_TOKEN = RUN_ID.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  function makeOffer(overrides: Partial<SupplierOfferCurrent>): SupplierOfferCurrent {
    return {
      supplierId: "",
      offerKey: "",
      supplierSku: "",
      description: "",
      brand: "",
      quantity: 10,
      currency: "USD",
      price: 25,
      fxRateAtUpload: 1,
      fxRateTimestamp: nowIso,
      priceUsdAtUpload: 25,
      upc: "",
      ean: "",
      productId: null,
      candidateProductId: null,
      candidateReferenceProductId: null,
      matchType: "unmatched",
      matchConfidence: null,
      reviewStatus: "needs_review",
      referenceProductId: null,
      rejectedCandidateProductIds: [],
      reviewRequestedAt: null,
      currentlyListed: true,
      lastUploadId: "test_upload_1",
      uploadedAt: nowIso,
      ...overrides,
    };
  }

  function makeUpload(overrides: Partial<SupplierPriceUpload>): SupplierPriceUpload {
    return {
      id: "test_upload_1",
      supplierId: "",
      filename: "isolated-test.xlsx",
      blobUrl: "",
      uploadType: "full",
      status: "completed",
      seq: 1,
      totalRows: 0,
      processedRows: 0,
      autoMatched: 0,
      autoCreated: 0,
      needsReview: 0,
      newCandidates: 0,
      notAProduct: 0,
      startedAt: nowIso,
      completedAt: nowIso,
      error: null,
      ...overrides,
    };
  }

  async function seedSupplierWithOffers(name: string, offers: Record<string, SupplierOfferCurrent>, seq = 1) {
    const supplier = await getOrCreateSupplier(name);
    const generationId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await writeCandidateGeneration(supplier.id, generationId, offers);
    const upload = makeUpload({ supplierId: supplier.id, seq, totalRows: Object.keys(offers).length, processedRows: Object.keys(offers).length, needsReview: Object.keys(offers).length });
    const result = await commitGeneration({ supplierId: supplier.id, uploadId: upload.id, seq, generationId, finishedUpload: upload, newAliases: [], offersByProductOps: [] });
    return { supplier, generationId, commitResult: result };
  }

  console.log("\n=== 1. Master Product creation (real Redis, get-or-create) ===");
  const supplierA = await getOrCreateSupplier(`TEST_ISOLATED_SUPPLIER_A_${RUN_ID}`);
  const rowA = { offerKey: "isokey_a1", supplierSku: "A1", description: `TESTBRAND ISOLATED NOVA${RUN_TOKEN} (U) EDP 100ML`, brand: "TESTBRAND", upc: `1${RUN_ID.replace(/\D/g, "").slice(0, 12).padEnd(12, "0")}`, ean: "" };
  const attrsA = extractAttributes(`${rowA.brand} ${rowA.description}`, "TESTBRAND");
  const eligibilityA = checkAutoCreateEligibility(attrsA, true);
  check("seeded row is auto-create eligible", eligibilityA.eligible, eligibilityA.reason);
  const sigA = computeIdentitySignature(attrsA);

  const beforeCount = (await getAllReferenceProducts()).length;
  const createResult = await getOrCreateReferenceProductByIdentity(
    { upc: rowA.upc, ean: rowA.ean, signature: sigA },
    {
      brand: "TESTBRAND", name: rowA.description, description: rowA.description,
      sizeMl: attrsA.sizeMl, concentration: attrsA.concentration, isTester: attrsA.isTester,
      isGiftSet: attrsA.isGiftSet, isRefill: attrsA.isRefill, productForm: attrsA.productForm,
      upc: rowA.upc, ean: rowA.ean, productId: null, createdBy: "isolated_test",
      creationMethod: "auto_import", createdFromSupplierId: supplierA.id,
      createdFromUploadId: "test_upload_1", createdFromOfferKey: rowA.offerKey,
    }
  );
  check("first call CREATES a new Master Product", createResult.status === "created", JSON.stringify(createResult));
  const afterCount = (await getAllReferenceProducts()).length;
  check("Master Product count increased by exactly 1", afterCount === beforeCount + 1, `before=${beforeCount} after=${afterCount}`);
  const createdId = createResult.status === "created" ? createResult.id : "";
  const fetchedRecord = await getReferenceProduct(createdId);
  check("newly created record is fetchable via getReferenceProduct", fetchedRecord !== null);
  check("creationMethod/provenance persisted correctly", fetchedRecord?.creationMethod === "auto_import" && fetchedRecord?.createdFromSupplierId === supplierA.id);

  console.log("\n=== 2. Master Product REUSE — idempotent retry, same identity ===");
  const retryResult = await getOrCreateReferenceProductByIdentity(
    { upc: rowA.upc, ean: rowA.ean, signature: sigA },
    {
      brand: "TESTBRAND", name: rowA.description, description: rowA.description,
      sizeMl: attrsA.sizeMl, concentration: attrsA.concentration, isTester: attrsA.isTester,
      isGiftSet: attrsA.isGiftSet, isRefill: attrsA.isRefill, productForm: attrsA.productForm,
      upc: rowA.upc, ean: rowA.ean, productId: null, createdBy: "isolated_test_RETRY",
      creationMethod: "auto_import", createdFromSupplierId: "SHOULD_NOT_OVERWRITE",
      createdFromUploadId: "SHOULD_NOT_OVERWRITE", createdFromOfferKey: "SHOULD_NOT_OVERWRITE",
    }
  );
  check("second identical call returns EXISTING (reuse), not CREATED", retryResult.status === "existing", JSON.stringify(retryResult));
  check("returned id matches the original", retryResult.status === "existing" && retryResult.id === createdId);
  const countAfterRetry = (await getAllReferenceProducts()).length;
  check("NO duplicate Master Product created on retry", countAfterRetry === afterCount, `after-first=${afterCount} after-retry=${countAfterRetry}`);
  const recordAfterRetry = await getReferenceProduct(createdId);
  check(
    "original provenance NEVER overwritten by the retry's different createdBy/createdFrom* values",
    recordAfterRetry?.createdBy === "isolated_test" && recordAfterRetry?.createdFromSupplierId === supplierA.id
  );

  console.log("\n=== 3. Supplier-offer linking + reverse-index update + price/quantity visibility ===");
  const offerA = makeOffer({ supplierId: supplierA.id, offerKey: rowA.offerKey, supplierSku: rowA.supplierSku, description: rowA.description, brand: rowA.brand, upc: rowA.upc, price: 42.5, quantity: 7, currency: "USD" });
  await seedSupplierWithOffers(`TEST_ISOLATED_SUPPLIER_A_${RUN_ID}`, { [rowA.offerKey]: offerA });
  const linkResult = await bulkUpdateOffers(
    supplierA.id,
    { [rowA.offerKey]: { ...offerA, referenceProductId: createdId, candidateReferenceProductId: createdId, matchType: "structured", matchConfidence: 1, reviewStatus: "auto_matched" } },
    { offersByReferenceProductOps: [{ op: "SADD", referenceProductId: createdId, member: `${supplierA.id}::${rowA.offerKey}` }] }
  );
  check("bulkUpdateOffers reports success", linkResult.ok === true, JSON.stringify(linkResult));
  const offersAfterLink = await getCommittedOffers(supplierA.id);
  const linkedOffer = offersAfterLink[rowA.offerKey];
  check("offer's referenceProductId is set after linking", linkedOffer?.referenceProductId === createdId);
  check("offer's reviewStatus is auto_matched", linkedOffer?.reviewStatus === "auto_matched");
  check("price is IMMEDIATELY visible and unchanged after linking ($42.50)", linkedOffer?.price === 42.5, `got ${linkedOffer?.price}`);
  check("quantity is IMMEDIATELY visible and unchanged after linking (7)", linkedOffer?.quantity === 7, `got ${linkedOffer?.quantity}`);
  check("currency preserved (USD)", linkedOffer?.currency === "USD");
  const reverseIndexMembers = await getOffersByReferenceProduct(createdId);
  check(
    "reverse index (offers_by_reference_product) contains this exact supplier+offerKey",
    reverseIndexMembers.some((m) => m.supplierId === supplierA.id && m.offerKey === rowA.offerKey)
  );

  console.log("\n=== 4. Second supplier's row for the SAME identity links via matchSupplierRow, no duplicate ===");
  const supplierB = await getOrCreateSupplier(`TEST_ISOLATED_SUPPLIER_B_${RUN_ID}`);
  const rowB = { offerKey: "isokey_b1", supplierSku: "B1", description: `ISOLATED NOVA${RUN_TOKEN} BY TESTBRAND (U) EDP 3.4OZ`, brand: "TESTBRAND", upc: rowA.upc, ean: "" };
  const poolForB = await getAllReferenceProducts();
  const matchB = matchSupplierRow(rowB, [], [], poolForB);
  check(
    "second supplier's differently-worded row for the SAME UPC links to the SAME existing Master Product",
    matchB.reviewStatus === "auto_matched" && matchB.referenceProductId === createdId,
    `got ${matchB.reviewStatus} ref=${matchB.referenceProductId}`
  );
  const offerB = makeOffer({ supplierId: supplierB.id, offerKey: rowB.offerKey, supplierSku: rowB.supplierSku, description: rowB.description, brand: rowB.brand, upc: rowB.upc, price: 39.99, quantity: 3 });
  await seedSupplierWithOffers(`TEST_ISOLATED_SUPPLIER_B_${RUN_ID}`, { [rowB.offerKey]: offerB });
  const linkResultB = await bulkUpdateOffers(
    supplierB.id,
    { [rowB.offerKey]: { ...offerB, referenceProductId: matchB.referenceProductId, candidateReferenceProductId: matchB.referenceProductId, matchType: matchB.matchType, matchConfidence: matchB.matchConfidence, reviewStatus: "auto_matched" } },
    { offersByReferenceProductOps: matchB.referenceProductId ? [{ op: "SADD", referenceProductId: matchB.referenceProductId, member: `${supplierB.id}::${rowB.offerKey}` }] : [] }
  );
  check("second supplier's offer link succeeds", linkResultB.ok === true);
  const reverseIndexAfterB = await getOffersByReferenceProduct(createdId);
  check("reverse index now shows BOTH suppliers' offers for the same Master Product", reverseIndexAfterB.length === 2, `got ${reverseIndexAfterB.length}`);
  const countAfterSecondSupplier = (await getAllReferenceProducts()).length;
  check("Master Product count STILL unchanged (no duplicate created for supplier B's row)", countAfterSecondSupplier === afterCount);

  console.log("\n=== 5. Migration run TWICE end-to-end — zero duplicates the second time ===");
  const secondRunMatch = matchSupplierRow(rowA, [], [], await getAllReferenceProducts());
  check("second full run of offer A resolves via existing-match, not get-or-create", secondRunMatch.referenceProductId === createdId);
  const countAfterSecondRun = (await getAllReferenceProducts()).length;
  check("Master Product count unchanged after re-running the whole flow a second time", countAfterSecondRun === afterCount);

  console.log("\n=== 6. Safe behavior after INTERRUPTED processing — no partial generation becomes active ===");
  const supplierD = await getOrCreateSupplier(`TEST_ISOLATED_SUPPLIER_D_INTERRUPTED_${RUN_ID}`);
  const gen1Offer = makeOffer({ supplierId: supplierD.id, offerKey: "d_key1", description: "ORIGINAL GEN1 OFFER", price: 10, quantity: 1 });
  const { generationId: gen1Id } = await seedSupplierWithOffers(`TEST_ISOLATED_SUPPLIER_D_INTERRUPTED_${RUN_ID}`, { d_key1: gen1Offer }, 1);
  const activeGenBeforeInterrupt = await getCurrentGenerationId(supplierD.id);
  check("supplier D has a real committed generation (gen1) before the interruption", activeGenBeforeInterrupt === gen1Id);

  // Simulate a crash: stage a SECOND generation's hash (writeCandidateGeneration)
  // but NEVER call commitGeneration for it — exactly what happens if the
  // process dies mid-upload, after staging but before the atomic commit.
  const gen2Id = `gen_${Date.now()}_interrupted`;
  const gen2Offer = makeOffer({ supplierId: supplierD.id, offerKey: "d_key1", description: "INTERRUPTED GEN2 OFFER — SHOULD NEVER BE VISIBLE", price: 999, quantity: 999 });
  await writeCandidateGeneration(supplierD.id, gen2Id, { d_key1: gen2Offer });

  const offersDuringInterruption = await getCommittedOffers(supplierD.id);
  check(
    "an interrupted (staged-but-never-committed) generation is NEVER visible to readers — offer still shows gen1's original price/quantity",
    offersDuringInterruption.d_key1?.price === 10 && offersDuringInterruption.d_key1?.quantity === 1,
    `got price=${offersDuringInterruption.d_key1?.price} quantity=${offersDuringInterruption.d_key1?.quantity}`
  );
  const activeGenDuringInterruption = await getCurrentGenerationId(supplierD.id);
  check("no partial supplier generation became active — current generation pointer still points at gen1", activeGenDuringInterruption === gen1Id);

  // Now complete the interrupted upload properly (the real recovery
  // path: re-commit for the SAME staged generation, exactly what a
  // retry does) and confirm it activates cleanly with no leftover mess.
  const gen2Upload = makeUpload({ supplierId: supplierD.id, seq: 2, totalRows: 1, processedRows: 1, needsReview: 1 });
  const gen2Commit = await commitGeneration({ supplierId: supplierD.id, uploadId: gen2Upload.id, seq: 2, generationId: gen2Id, finishedUpload: gen2Upload, newAliases: [], offersByProductOps: [] });
  check("completing the interrupted upload (retry-commit) succeeds", gen2Commit === "OK", gen2Commit);
  const offersAfterRecovery = await getCommittedOffers(supplierD.id);
  check("after proper completion, the new generation's data is now correctly visible", offersAfterRecovery.d_key1?.price === 999 && offersAfterRecovery.d_key1?.quantity === 999);

  // STALE_GENERATION guard: an older/duplicate seq must never be able to
  // clobber the newer, already-active generation.
  const staleUpload = makeUpload({ supplierId: supplierD.id, seq: 1, totalRows: 1, processedRows: 1 });
  const staleCommit = await commitGeneration({ supplierId: supplierD.id, uploadId: staleUpload.id, seq: 1, generationId: "gen_stale_attempt", finishedUpload: staleUpload, newAliases: [], offersByProductOps: [] });
  check("a stale/older seq commit is rejected (STALE_GENERATION), never overwrites the newer active generation", staleCommit === "STALE_GENERATION", staleCommit);
  const offersAfterStaleAttempt = await getCommittedOffers(supplierD.id);
  check("active generation is unaffected by the rejected stale commit attempt", offersAfterStaleAttempt.d_key1?.price === 999);

  console.log("\n=== 7. Reverse-index repair procedure — simulates the exact HSET-succeeded-SADD-never-ran gap ===");
  const { backfillOfferByReferenceProduct, getOffersByReferenceProduct: getRefMembers } = await import("../src/lib/pricing-db");
  const supplierE = await getOrCreateSupplier(`TEST_ISOLATED_SUPPLIER_E_REPAIR_${RUN_ID}`);
  const brokenOffer = makeOffer({ supplierId: supplierE.id, offerKey: "e_key1", description: "TESTBRAND REPAIR CASE (U) EDT 50ML", referenceProductId: createdId, reviewStatus: "auto_matched", matchType: "structured", matchConfidence: 1 });
  await seedSupplierWithOffers(`TEST_ISOLATED_SUPPLIER_E_REPAIR_${RUN_ID}`, { e_key1: brokenOffer });
  // Deliberately do NOT add e_key1 to offers_by_reference_product — this
  // is the exact state a crash between bulkUpdateOffers's HSET and SADD
  // calls would leave behind: referenceProductId set, reverse index
  // membership missing.
  const membersBeforeRepair = await getRefMembers(createdId);
  check(
    "setup: the broken offer is confirmed MISSING from the reverse index before repair",
    !membersBeforeRepair.some((m) => m.supplierId === supplierE.id && m.offerKey === "e_key1")
  );

  // Detection: exactly the query verify-reverse-index-integrity.ts runs.
  const isDetectedAsMissing = !(await getRefMembers(createdId)).some((m) => m.supplierId === supplierE.id && m.offerKey === "e_key1");
  check("detection correctly identifies the gap (offer resolved but not reverse-indexed)", isDetectedAsMissing);

  // Repair: the exact primitive verify-reverse-index-integrity.ts's
  // --repair mode calls — a plain, idempotent SADD, no bespoke logic.
  await backfillOfferByReferenceProduct(createdId, supplierE.id, "e_key1");
  const membersAfterRepair = await getRefMembers(createdId);
  check(
    "repair correctly adds the missing reverse-index membership",
    membersAfterRepair.some((m) => m.supplierId === supplierE.id && m.offerKey === "e_key1")
  );

  // Idempotency: running the repair a second time must not create a
  // duplicate SET member or otherwise misbehave (SADD is naturally
  // idempotent, but confirm the actual behavior, not just the theory).
  await backfillOfferByReferenceProduct(createdId, supplierE.id, "e_key1");
  const membersAfterSecondRepair = await getRefMembers(createdId);
  check(
    "repairing twice is idempotent — no duplicate membership, same count as after one repair",
    membersAfterSecondRepair.length === membersAfterRepair.length
  );

  // Confirm repair never touches the offer's OWN hash fields (price,
  // reviewStatus, etc.) — it is purely additive to the reverse index.
  const offerAfterRepair = (await getCommittedOffers(supplierE.id)).e_key1;
  check(
    "repair does not modify the offer's own fields (price/reviewStatus unchanged)",
    offerAfterRepair?.price === brokenOffer.price && offerAfterRepair?.reviewStatus === "auto_matched"
  );

  console.log(`\n=== RESULTS: ${pass} passed, ${fail_} failed (${results.length} total assertions) ===`);
  console.log("\nFull PASS/FAIL list:");
  for (const r of results) console.log(`  [${r.status}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);

  console.log("\nCleaning up isolated test data (best-effort; the temp DB expires on its own regardless)...");
  await redis.del(pingKey);

  if (fail_ > 0) {
    console.error(`\n${fail_} assertion(s) FAILED. Do not treat this run as a pass.`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
}

main().catch((err) => {
  console.error("FATAL — test did not complete:", err);
  process.exit(1);
});
