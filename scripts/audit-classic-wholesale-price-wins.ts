// READ-ONLY audit. Investigates why Classic Wholesale's Price Wins shows
// "0 of 0" despite a completed upload. Covers checklist sections 1-4:
// commit verification, reverse-index completeness, the Price Wins
// eligibility funnel, and the leaderboard cache/fingerprint state.
// Zero writes anywhere.
import {
  getCurrentGenerationId,
  getCommittedOffers,
  getAllReferenceProducts,
  getOffersByReferenceProduct,
  getOffersByProduct,
  getSupplierPriceLeaderboard,
  isActionableOffer,
  getUploadsForSupplier,
} from "../src/lib/pricing-db";
import { getSuppliers } from "../src/lib/intake-db";
import { getProducts } from "../src/lib/db";
import { getUsdRate, convertToUsd } from "../src/lib/pricing-fx";
import { redis } from "../src/lib/kv";
import type { OfferComparisonRow, SupplierOfferCurrent, PricingReferenceProduct } from "../src/lib/pricing-types";
import type { Product } from "../src/lib/types";

const SUPPLIER_ID = "sup_1790700359624_5oy1mu";
const DEFAULT_FRESHNESS_THRESHOLD_DAYS = 14;

function ageDaysOf(uploadedAt: string): number {
  return (Date.now() - new Date(uploadedAt).getTime()) / (1000 * 60 * 60 * 24);
}

async function buildRow(o: SupplierOfferCurrent, supplierName: string): Promise<OfferComparisonRow> {
  const rate = await getUsdRate(o.currency);
  const converted = convertToUsd(o.price, rate?.rate ?? null);
  const ageDays = ageDaysOf(o.uploadedAt);
  return {
    supplierId: o.supplierId,
    supplierName,
    offerKey: o.offerKey,
    price: o.price,
    currency: o.currency,
    priceUsd: converted ?? o.price,
    priceUsdValid: converted !== null,
    currentlyListed: o.currentlyListed,
    quantity: o.quantity,
    isStale: ageDays > DEFAULT_FRESHNESS_THRESHOLD_DAYS,
    ageDays: Math.round(ageDays * 10) / 10,
    uploadedAt: o.uploadedAt,
    reviewStatus: o.reviewStatus,
    differenceFromBestUsd: null,
  };
}

async function main() {
  console.log("############################################");
  console.log("# 1. WHAT ACTUALLY COMMITTED");
  console.log("############################################\n");

  const genId = await getCurrentGenerationId(SUPPLIER_ID);
  const offers = await getCommittedOffers(SUPPLIER_ID);
  const offerList = Object.values(offers);
  console.log(`Current generation ID: ${genId}`);
  console.log(`Total committed offers: ${offerList.length}`);

  const linkedToRef = offerList.filter((o) => o.referenceProductId || o.productId);
  const unmatched = offerList.filter((o) => !o.referenceProductId && !o.productId);
  const listed = offerList.filter((o) => o.currentlyListed);
  const inStock = offerList.filter((o) => o.quantity === null || o.quantity > 0);
  console.log(`Linked to a PricingReferenceProduct or real Product: ${linkedToRef.length}`);
  console.log(`Unmatched/unresolved: ${unmatched.length}`);
  console.log(`Marked listed (currentlyListed=true): ${listed.length}`);
  console.log(`Marked in stock (quantity null or >0): ${inStock.length}`);

  const [suppliers] = await Promise.all([getSuppliers()]);
  const supplierName = suppliers.find((s) => s.id === SUPPLIER_ID)?.name ?? "Classic Wholesale";
  const rows = await Promise.all(offerList.map((o) => buildRow(o, supplierName)));
  const validUsd = rows.filter((r) => r.priceUsdValid);
  const actionable = rows.filter(isActionableOffer);
  console.log(`With valid USD price: ${validUsd.length}`);
  console.log(`ACTIONABLE (currentlyListed + qty ok + !stale + priceUsdValid + reviewStatus auto_matched/confirmed): ${actionable.length}`);

  const nonActionableReasons = new Map<string, number>();
  for (const r of rows) {
    if (isActionableOffer(r)) continue;
    const reasons: string[] = [];
    if (!r.currentlyListed) reasons.push("not currentlyListed");
    if (!(r.quantity === null || r.quantity > 0)) reasons.push("quantity <= 0");
    if (r.isStale) reasons.push("stale (>14d)");
    if (!r.priceUsdValid) reasons.push("invalid USD price");
    if (!(r.reviewStatus === "auto_matched" || r.reviewStatus === "confirmed")) reasons.push(`reviewStatus=${r.reviewStatus}`);
    const key = reasons.join(" + ") || "unknown";
    nonActionableReasons.set(key, (nonActionableReasons.get(key) ?? 0) + 1);
  }
  console.log(`\nNon-actionable offers grouped by reason (${rows.length - actionable.length} total):`);
  for (const [reason, count] of [...nonActionableReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toLocaleString()} — ${reason}`);
  }

  console.log("\n############################################");
  console.log("# 2. REVERSE INDEX VERIFICATION");
  console.log("############################################\n");

  const offersWithRefId = offerList.filter((o) => o.referenceProductId);
  const offersWithProductId = offerList.filter((o) => o.productId);
  const distinctRefIds = new Set(offersWithRefId.map((o) => o.referenceProductId!));
  const distinctProductIds = new Set(offersWithProductId.map((o) => o.productId!));
  console.log(`Offers with referenceProductId: ${offersWithRefId.length} (${distinctRefIds.size} distinct reference products)`);
  console.log(`Offers with productId: ${offersWithProductId.length} (${distinctProductIds.size} distinct real products)`);

  let expectedRefMemberships = 0;
  let missingRefMemberships = 0;
  let duplicateRefMemberships = 0;
  const missingSamples: string[] = [];
  for (const refId of distinctRefIds) {
    const expectedOfferKeys = new Set(offersWithRefId.filter((o) => o.referenceProductId === refId).map((o) => o.offerKey));
    expectedRefMemberships += expectedOfferKeys.size;
    const members = await getOffersByReferenceProduct(refId);
    const thisSupplierMembers = members.filter((m) => m.supplierId === SUPPLIER_ID);
    const memberKeys = new Set(thisSupplierMembers.map((m) => m.offerKey));
    for (const key of expectedOfferKeys) {
      if (!memberKeys.has(key)) {
        missingRefMemberships++;
        if (missingSamples.length < 10) missingSamples.push(`${refId} / ${key}`);
      }
    }
    // duplicate membership check (same supplierId::offerKey appearing more than once is impossible in a Redis SET, but check for a key appearing when it shouldn't)
    if (thisSupplierMembers.length > memberKeys.size) duplicateRefMemberships += thisSupplierMembers.length - memberKeys.size;
  }
  console.log(`Expected reverse-index memberships (offers_by_reference_product, this supplier): ${expectedRefMemberships}`);
  console.log(`Actual memberships found: ${expectedRefMemberships - missingRefMemberships}`);
  console.log(`Missing memberships: ${missingRefMemberships}${missingSamples.length ? " — samples: " + missingSamples.join(", ") : ""}`);
  console.log(`Duplicate memberships: ${duplicateRefMemberships}`);

  let expectedProductMemberships = 0;
  let missingProductMemberships = 0;
  for (const pid of distinctProductIds) {
    const expectedOfferKeys = new Set(offersWithProductId.filter((o) => o.productId === pid).map((o) => o.offerKey));
    expectedProductMemberships += expectedOfferKeys.size;
    const members = await getOffersByProduct(pid);
    const memberKeys = new Set(members.filter((m) => m.supplierId === SUPPLIER_ID).map((m) => m.offerKey));
    for (const key of expectedOfferKeys) if (!memberKeys.has(key)) missingProductMemberships++;
  }
  console.log(`\noffers_by_product: expected ${expectedProductMemberships}, missing ${missingProductMemberships}`);

  console.log("\n############################################");
  console.log("# 3. PRICE WINS ELIGIBILITY FUNNEL");
  console.log("############################################\n");

  const [allReferenceProducts, allProducts] = await Promise.all([getAllReferenceProducts(), getProducts()]);
  const refById = new Map(allReferenceProducts.map((rp) => [rp.id, rp]));
  const productById = new Map(allProducts.map((p) => [p.id, p]));

  let stepCommitted = offerList.length;
  let stepMatched = 0;
  let stepListed = 0;
  let stepInStock = 0;
  let stepFresh = 0;
  let stepActionable = 0;
  let stepHasCompetitor = 0;
  let stepCheapest = 0;

  // Need full leaderboard-style cross-supplier data to check "has >=1
  // eligible competitor" and "Classic is cheapest" per identity.
  const allSuppliers = await getSuppliers();
  const offersBySupplier = await Promise.all(allSuppliers.map((s) => getCommittedOffers(s.id)));
  const currencies = new Set<string>();
  for (const sOffers of offersBySupplier) for (const o of Object.values(sOffers)) currencies.add(o.currency);
  const rateByCurrency = new Map<string, number | null>();
  await Promise.all([...currencies].map(async (c) => { const r = await getUsdRate(c); rateByCurrency.set(c, r?.rate ?? null); }));

  function resolveIdentityKey(o: SupplierOfferCurrent): string | null {
    if (o.productId) return o.productId;
    if (o.referenceProductId) {
      const rp = refById.get(o.referenceProductId);
      if (!rp) return null;
      return rp.productId ?? rp.id;
    }
    return null;
  }

  // Build actionable-row-by-supplier-by-identity for ALL suppliers (same
  // grouping the leaderboard itself does), so we can check competitor
  // eligibility per Classic offer.
  const bestRowByIdentityBySupplier = new Map<string, Map<string, OfferComparisonRow>>();
  for (let i = 0; i < allSuppliers.length; i++) {
    const sid = allSuppliers[i].id;
    for (const o of Object.values(offersBySupplier[i])) {
      const key = resolveIdentityKey(o);
      if (!key) continue;
      const rate = rateByCurrency.get(o.currency) ?? null;
      const converted = convertToUsd(o.price, rate);
      const ageDays = ageDaysOf(o.uploadedAt);
      const row: OfferComparisonRow = {
        supplierId: sid, supplierName: allSuppliers[i].name, offerKey: o.offerKey, price: o.price, currency: o.currency,
        priceUsd: converted ?? o.price, priceUsdValid: converted !== null, currentlyListed: o.currentlyListed, quantity: o.quantity,
        isStale: ageDays > DEFAULT_FRESHNESS_THRESHOLD_DAYS, ageDays: Math.round(ageDays * 10) / 10, uploadedAt: o.uploadedAt,
        reviewStatus: o.reviewStatus, differenceFromBestUsd: null,
      };
      if (!isActionableOffer(row)) continue;
      if (!bestRowByIdentityBySupplier.has(key)) bestRowByIdentityBySupplier.set(key, new Map());
      const bySupplier = bestRowByIdentityBySupplier.get(key)!;
      const existing = bySupplier.get(sid);
      if (!existing || row.priceUsd < existing.priceUsd) bySupplier.set(sid, row);
    }
  }

  for (const o of offerList) {
    const key = resolveIdentityKey(o);
    if (!key) continue;
    stepMatched++;
    if (!o.currentlyListed) continue;
    stepListed++;
    if (!(o.quantity === null || o.quantity > 0)) continue;
    stepInStock++;
    const ageDays = ageDaysOf(o.uploadedAt);
    if (ageDays > DEFAULT_FRESHNESS_THRESHOLD_DAYS) continue;
    stepFresh++;
    const row = await buildRow(o, supplierName);
    if (!isActionableOffer(row)) continue;
    stepActionable++;
    const bySupplier = bestRowByIdentityBySupplier.get(key);
    const competitorCount = bySupplier ? [...bySupplier.keys()].filter((sid) => sid !== SUPPLIER_ID).length : 0;
    if (competitorCount < 1) continue;
    stepHasCompetitor++;
    const classicRow = bySupplier!.get(SUPPLIER_ID)!;
    const cheapestOverall = Math.min(...[...bySupplier!.values()].map((r) => r.priceUsd));
    if (Math.round(classicRow.priceUsd * 100) === Math.round(cheapestOverall * 100)) stepCheapest++;
  }

  console.log(`committed:                    ${stepCommitted}`);
  console.log(`-> matched to Master Product:  ${stepMatched}`);
  console.log(`-> listed:                     ${stepListed}`);
  console.log(`-> in stock:                   ${stepInStock}`);
  console.log(`-> fresh (<=14d):              ${stepFresh}`);
  console.log(`-> actionable:                 ${stepActionable}`);
  console.log(`-> has >=1 eligible competitor: ${stepHasCompetitor}`);
  console.log(`-> Classic is cheapest:        ${stepCheapest}`);

  console.log("\n############################################");
  console.log("# 4. LEADERBOARD / CACHE PIPELINE");
  console.log("############################################\n");

  const cachedMeta = await redis.get<{ catalogVersion: number; generationFingerprint: string; computedAt: string }>("amoruh:pricing:leaderboard:meta");
  console.log(`Cached leaderboard meta: ${JSON.stringify(cachedMeta)}`);

  const catalogVersion = (await redis.get<number>("amoruh:pricing:catalog_version")) ?? 0;
  console.log(`Current catalogVersion: ${catalogVersion}`);

  // Fresh, freshness-verified read through the REAL entry point (will
  // recompute if stale) -- this is what every UI consumer actually calls.
  const t0 = Date.now();
  const liveLeaderboard = await getSupplierPriceLeaderboard();
  console.log(`getSupplierPriceLeaderboard() took ${Date.now() - t0}ms`);
  console.log(`Live leaderboard computedAt: ${liveLeaderboard.computedAt}`);
  console.log(`Live leaderboard generationFingerprint includes Classic? ${liveLeaderboard.generationFingerprint.includes(SUPPLIER_ID)}`);
  const classicSummary = liveLeaderboard.suppliers.find((s) => s.supplierId === SUPPLIER_ID);
  console.log(`\nClassic Wholesale's leaderboard summary (LIVE, freshness-verified):`);
  console.log(JSON.stringify(classicSummary, null, 2));
  console.log(`\nLeaderboard totals: ${JSON.stringify(liveLeaderboard.totals)}`);
  console.log(`Total suppliers in leaderboard: ${liveLeaderboard.suppliers.length}`);

  console.log("\n############################################");
  console.log("# 7. STUCK UPLOAD HISTORY INFLUENCE CHECK");
  console.log("############################################\n");
  const uploads = await getUploadsForSupplier(SUPPLIER_ID, 20);
  for (const u of uploads) console.log(`  ${u.id} status=${u.status} ${u.processedRows}/${u.totalRows} started=${u.startedAt}`);
  console.log(`\nCurrent generation id (should be the COMPLETED upload's generation, never a "processing" one): ${genId}`);
  console.log(`(Stuck "processing" uploads never called commitGeneration -- they cannot be the current generation by construction; getCurrentOffer/getCommittedOffers only ever read via currentGenerationId, which those uploads never set.)`);
}
main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
