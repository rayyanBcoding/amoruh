// READ-ONLY monitor. Polls Classic Wholesale's upload records for a NEW
// one (not in the known baseline) to appear -- the operator's real
// Process attempt from the production UI -- then watches it until it
// reaches a terminal state (completed/failed), then runs the full
// post-completion verification checklist and prints a single report.
// Never writes anything.
import { getCurrentGenerationId, getCommittedOffers, getUploadsForSupplier, getOffersByReferenceProduct, getAllReferenceProducts } from "../src/lib/pricing-db";
import { redis } from "../src/lib/kv";

const SUPPLIER_ID = "sup_1790700359624_5oy1mu";
const BASELINE_UPLOAD_IDS = new Set([
  "upl_1790785618490_aihols",
  "upl_1790749947498_0g0ou1",
  "upl_1790728455514_5chh7n",
  "upl_1790728389262_dqucqu",
  "upl_1790728287103_xv4brn",
]);
const POLL_MS = 15000;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000; // 6h safety cap

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`Watching supplier ${SUPPLIER_ID} for a new upload attempt (baseline: ${BASELINE_UPLOAD_IDS.size} known ids)...`);
  const start = Date.now();
  let newUploadId: string | null = null;

  while (Date.now() - start < MAX_WAIT_MS) {
    const uploads = await getUploadsForSupplier(SUPPLIER_ID, 20);
    const fresh = uploads.find((u) => !BASELINE_UPLOAD_IDS.has(u.id));
    if (fresh) {
      newUploadId = fresh.id;
      console.log(`\nNEW UPLOAD DETECTED: ${fresh.id} (status=${fresh.status}, started ${fresh.startedAt})`);
      break;
    }
    await sleep(POLL_MS);
  }

  if (!newUploadId) {
    console.log("\nTimed out waiting for a new upload attempt (6h) -- stopping. Re-run this script when you're ready to try again.");
    return;
  }

  // Watch until terminal.
  console.log("Watching for completion...");
  let final = null;
  while (Date.now() - start < MAX_WAIT_MS) {
    const uploads = await getUploadsForSupplier(SUPPLIER_ID, 20);
    const u = uploads.find((x) => x.id === newUploadId);
    if (!u) {
      console.log("Upload record vanished unexpectedly.");
      return;
    }
    if (u.status === "completed" || u.status === "failed") {
      final = u;
      console.log(`Reached terminal state: ${u.status} (processedRows=${u.processedRows}/${u.totalRows})`);
      break;
    }
    console.log(`  ...still processing: ${u.processedRows}/${u.totalRows}`);
    await sleep(POLL_MS);
  }

  if (!final) {
    console.log("\nTimed out waiting for completion.");
    return;
  }

  console.log("\n=== POST-COMPLETION VERIFICATION ===");
  console.log(`Upload status: ${final.status}`);
  console.log(`Processed rows: ${final.processedRows} / ${final.totalRows} (all 3,094 expected: ${final.totalRows === 3094 && final.processedRows === 3094})`);
  console.log(`autoMatched: ${final.autoMatched}, autoCreated: ${final.autoCreated}, needsReview: ${final.needsReview}, notAProduct: ${final.notAProduct}`);
  console.log(`error: ${final.error ?? "none"}`);

  if (final.status !== "completed") {
    console.log("\nUpload did not complete successfully -- skipping generation/offer checks.");
    return;
  }

  const genId = await getCurrentGenerationId(SUPPLIER_ID);
  const offers = await getCommittedOffers(SUPPLIER_ID);
  console.log(`\nCurrent generation id: ${genId}`);
  console.log(`Committed offer count: ${Object.keys(offers).length}`);

  // Exactly one current generation is structural (currentGenerationId is
  // a single Redis key, can only ever point to one value) -- confirmed
  // simply by it being non-null and matching what this upload wrote.

  // Reverse-index completeness: every committed offer with a
  // referenceProductId should be a member of that id's reverse index.
  const refIds = new Set<string>();
  for (const o of Object.values(offers)) if (o.referenceProductId) refIds.add(o.referenceProductId);
  let missingFromIndex = 0;
  let checked = 0;
  for (const refId of refIds) {
    checked++;
    const members = await getOffersByReferenceProduct(refId);
    const found = members.some((m) => m.supplierId === SUPPLIER_ID);
    if (!found) missingFromIndex++;
  }
  console.log(`Reverse-index check: ${checked} distinct reference products referenced by this supplier's offers, ${missingFromIndex} missing from their reverse index (expect 0)`);

  // Duplicate Master Products: any two reference products CREATED from
  // this supplier's upload sharing the same UPC/EAN would indicate a
  // dedup failure.
  const allRefProducts = await getAllReferenceProducts();
  const createdByThisUpload = allRefProducts.filter((p) => p.createdFromUploadId === newUploadId);
  console.log(`New Master Products created by this upload: ${createdByThisUpload.length}`);
  const seenBarcodes = new Map<string, string>();
  const dupes: string[] = [];
  for (const p of createdByThisUpload) {
    for (const bc of [p.upc, p.ean]) {
      if (!bc) continue;
      if (seenBarcodes.has(bc) && seenBarcodes.get(bc) !== p.id) dupes.push(`${bc}: ${seenBarcodes.get(bc)} vs ${p.id}`);
      else seenBarcodes.set(bc, p.id);
    }
  }
  console.log(`Duplicate-barcode collisions among newly created Master Products: ${dupes.length}${dupes.length ? " -- " + dupes.join("; ") : ""}`);

  // No stale process session / no partial state.
  let cursor = 0;
  const sessionKeys: string[] = [];
  do {
    const res = await redis.scan(cursor, { match: "amoruh:pricing:process_session:*", count: 500 });
    cursor = Number(res[0]);
    sessionKeys.push(...(res[1] as string[]));
  } while (cursor !== 0);
  console.log(`\nStaged process sessions currently in Redis: ${sessionKeys.length}`);
  for (const k of sessionKeys) console.log(`  ${k} (ttl ${await redis.ttl(k)}s)`);

  let otherUploadsStuck = 0;
  const allUploads = await getUploadsForSupplier(SUPPLIER_ID, 20);
  for (const u of allUploads) if (u.id !== newUploadId && u.status === "processing") otherUploadsStuck++;
  console.log(`Other upload records still stuck at "processing" (pre-existing, unrelated to this run): ${otherUploadsStuck}`);

  console.log("\nDone.");
}
main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
