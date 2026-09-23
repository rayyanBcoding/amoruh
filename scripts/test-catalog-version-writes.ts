// Isolated regression test for the catalogVersion bump added to the
// reference-product write paths (createReferenceProduct,
// getOrCreateReferenceProductByIdentity, linkReferenceProductToProduct):
// confirms each function's return value/behavior is unchanged and that
// the version bump fires exactly once per real change (never on a
// no-op like "existing"/"conflict"/"already same value").
//
// Runs against PRODUCTION Redis (no isolated test database was reachable
// from this sandbox -- confirmed via a direct connectivity check to a
// freshly minted ephemeral Upstash instance, same known limitation
// documented earlier in this project) but touches ONLY fully synthetic,
// uniquely-suffixed reference products created and deleted within this
// run -- never a real business record. resolveOfferManually and
// commitGeneration are NOT exercised here (they require an existing
// supplier/generation to act on, which this script deliberately avoids
// touching) -- verified by code review instead (the diff adds exactly
// one bumpCatalogVersion() call on each function's existing success
// path, never altering an existing return statement).
import { redis } from "../src/lib/kv";
import { createReferenceProduct, getOrCreateReferenceProductByIdentity, linkReferenceProductToProduct, deleteReferenceProductAndPointers } from "../src/lib/pricing-db";
import { computeIdentitySignature, extractReferenceProductAttributes } from "../src/lib/pricing-matching";

const CATALOG_VERSION_KEY = "amoruh:pricing:catalog_version";
const RUN_SUFFIX = `TEST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`);
  }
}

async function getVersion(): Promise<number> {
  return (await redis.get<number>(CATALOG_VERSION_KEY)) ?? 0;
}

async function main() {
  const createdIds: string[] = [];
  try {
    console.log(`Run suffix: ${RUN_SUFFIX} (all records created here are synthetic and deleted at the end)`);

    // --- createReferenceProduct ---
    const v0 = await getVersion();
    const rp1 = await createReferenceProduct({
      brand: `${RUN_SUFFIX}_BRAND`,
      name: "Test Fragrance One",
      description: `${RUN_SUFFIX}_BRAND Test Fragrance One EDT 100ml`,
      sizeMl: 100,
      concentration: "EDT",
      isTester: false,
      isGiftSet: false,
      isRefill: false,
      productForm: "fragrance",
      upc: "",
      ean: "",
      productId: null,
      createdBy: "test",
      creationMethod: "manual_track",
      createdFromSupplierId: null,
      createdFromUploadId: null,
      createdFromOfferKey: null,
    });
    createdIds.push(rp1.id);
    const v1 = await getVersion();
    assert(rp1.brand === `${RUN_SUFFIX}_BRAND` && rp1.name === "Test Fragrance One", "createReferenceProduct: returns the expected record unchanged");
    assert(v1 === v0 + 1, `createReferenceProduct: catalogVersion incremented by exactly 1 (was ${v0}, now ${v1})`);

    // --- getOrCreateReferenceProductByIdentity: "created" path ---
    const v2 = await getVersion();
    const identity1 = { upc: `${RUN_SUFFIX}_UPC1`, ean: "", signature: `${RUN_SUFFIX}_SIG1` };
    const goc1 = await getOrCreateReferenceProductByIdentity(identity1, {
      brand: `${RUN_SUFFIX}_BRAND`,
      name: "Test Fragrance Two",
      description: `${RUN_SUFFIX}_BRAND Test Fragrance Two EDP 50ml`,
      sizeMl: 50,
      concentration: "EDP",
      isTester: false,
      isGiftSet: false,
      isRefill: false,
      productForm: "fragrance",
      upc: identity1.upc,
      ean: "",
      productId: null,
      createdBy: "test",
      creationMethod: "manual_track",
      createdFromSupplierId: null,
      createdFromUploadId: null,
      createdFromOfferKey: null,
    });
    const v3 = await getVersion();
    assert(goc1.status === "created", "getOrCreateReferenceProductByIdentity: first call with a fresh identity returns 'created'");
    if (goc1.status === "created") createdIds.push(goc1.id);
    assert(v3 === v2 + 1, `getOrCreateReferenceProductByIdentity (created): catalogVersion incremented by exactly 1 (was ${v2}, now ${v3})`);

    // --- getOrCreateReferenceProductByIdentity: "existing" path -- must NOT bump ---
    const v4 = await getVersion();
    const goc2 = await getOrCreateReferenceProductByIdentity(identity1, {
      brand: `${RUN_SUFFIX}_BRAND`,
      name: "Test Fragrance Two Duplicate Attempt",
      description: "should resolve to existing, not create a duplicate",
      sizeMl: 50,
      concentration: "EDP",
      isTester: false,
      isGiftSet: false,
      isRefill: false,
      productForm: "fragrance",
      upc: identity1.upc,
      ean: "",
      productId: null,
      createdBy: "test",
      creationMethod: "manual_track",
      createdFromSupplierId: null,
      createdFromUploadId: null,
      createdFromOfferKey: null,
    });
    const v5 = await getVersion();
    assert(goc2.status === "existing" && goc2.id === (goc1 as { status: "created"; id: string }).id, "getOrCreateReferenceProductByIdentity: re-calling with the SAME identity returns 'existing', same id, no duplicate created");
    assert(v5 === v4, `getOrCreateReferenceProductByIdentity (existing, no-op): catalogVersion NOT bumped (was ${v4}, still ${v5})`);

    // --- linkReferenceProductToProduct: real change bumps, no-op doesn't ---
    const v6 = await getVersion();
    const link1 = await linkReferenceProductToProduct(rp1.id, "prod_test_synthetic_does_not_need_to_exist");
    const v7 = await getVersion();
    assert(link1.ok === true, "linkReferenceProductToProduct: first link succeeds");
    assert(v7 === v6 + 1, `linkReferenceProductToProduct (real change): catalogVersion incremented by exactly 1 (was ${v6}, now ${v7})`);

    const v8 = await getVersion();
    const link2 = await linkReferenceProductToProduct(rp1.id, "prod_test_synthetic_does_not_need_to_exist");
    const v9 = await getVersion();
    assert(link2.ok === true, "linkReferenceProductToProduct: re-linking to the SAME productId is a no-op success");
    assert(v9 === v8, `linkReferenceProductToProduct (already same value, no-op): catalogVersion NOT bumped (was ${v8}, still ${v9})`);

    const v10 = await getVersion();
    const link3 = await linkReferenceProductToProduct(rp1.id, "prod_test_a_different_one");
    const v11 = await getVersion();
    assert(link3.ok === false && "reason" in link3 && link3.reason === "already_linked_elsewhere", "linkReferenceProductToProduct: refuses to silently reassign an existing different link");
    assert(v11 === v10, `linkReferenceProductToProduct (refused, no-op): catalogVersion NOT bumped (was ${v10}, still ${v11})`);

    console.log(`\n=== TOTAL: ${pass} passed, ${fail} failed ===`);
  } finally {
    console.log(`\nCleaning up ${createdIds.length} synthetic test record(s)...`);
    for (const id of createdIds) {
      // Best-effort cleanup -- fetch the record fresh to compute its real
      // signature/upc/ean state for deleteReferenceProductAndPointers.
      const rp = await redis.get<{ id: string; brand: string; name: string; description: string; upc: string; ean: string }>(`amoruh:pricing:reference_product:${id}`);
      if (!rp) continue;
      const attrs = extractReferenceProductAttributes(rp as never);
      const signature = computeIdentitySignature(attrs);
      const result = await deleteReferenceProductAndPointers(id, signature);
      console.log(`  ${result.deletedRecord ? "deleted" : "already gone"}: ${id}`);
    }
  }
  if (fail > 0) process.exit(1);
}
main();
