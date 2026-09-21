// Detects (and, with --repair, fixes) the one real gap found during
// migration preflight: bulkUpdateOffers writes the offer's own
// referenceProductId/productId field and its reverse-index SADD as two
// SEPARATE calls (HSET first, then SADD), not one atomic script. A
// crash between those two steps -- or, per this exact investigation,
// ANY OTHER historical write path with the same shape -- can leave an
// offer that LOOKS resolved (referenceProductId/productId set) but is
// MISSING from offers_by_reference_product / offers_by_product. Because
// the migration's own unresolved-offer filter excludes offers with
// referenceProductId/productId already set, a simple rerun would never
// find or fix this -- this script is the targeted check that does.
//
// --repair uses ONLY the existing, idempotent backfillOfferByReferenceProduct
// primitive (a plain SADD) for the reference-product case, and
// bulkUpdateOffers's own offersByProductOps SADD path for the real-
// product case -- no new write primitive, no bespoke logic.
import { getSuppliers } from "../src/lib/intake-db";
import { getCommittedOffers, getOffersByReferenceProduct, getOffersByProduct, backfillOfferByReferenceProduct, bulkUpdateOffers } from "../src/lib/pricing-db";

const REPAIR = process.argv.includes("--repair");

async function main() {
  const suppliers = await getSuppliers();
  let checked = 0;
  let missingFromRefIndex = 0;
  let missingFromProductIndex = 0;
  const refIndexCache = new Map<string, Set<string>>();
  const productIndexCache = new Map<string, Set<string>>();
  const examples: string[] = [];

  for (const s of suppliers) {
    const offers = Object.values(await getCommittedOffers(s.id)).filter((o) => o.currentlyListed !== false);
    for (const o of offers) {
      if (!o.referenceProductId && !o.productId) continue;
      checked++;
      const member = `${s.id}::${o.offerKey}`;

      if (o.referenceProductId) {
        if (!refIndexCache.has(o.referenceProductId)) {
          const members = await getOffersByReferenceProduct(o.referenceProductId);
          refIndexCache.set(o.referenceProductId, new Set(members.map((m) => `${m.supplierId}::${m.offerKey}`)));
        }
        if (!refIndexCache.get(o.referenceProductId)!.has(member)) {
          missingFromRefIndex++;
          examples.push(`[${s.name}] offerKey=${o.offerKey} referenceProductId=${o.referenceProductId} MISSING from offers_by_reference_product`);
          if (REPAIR) {
            await backfillOfferByReferenceProduct(o.referenceProductId, s.id, o.offerKey);
            refIndexCache.get(o.referenceProductId)!.add(member);
          }
        }
      }

      if (o.productId) {
        if (!productIndexCache.has(o.productId)) {
          const members = await getOffersByProduct(o.productId);
          productIndexCache.set(o.productId, new Set(members.map((m) => `${m.supplierId}::${m.offerKey}`)));
        }
        if (!productIndexCache.get(o.productId)!.has(member)) {
          missingFromProductIndex++;
          examples.push(`[${s.name}] offerKey=${o.offerKey} productId=${o.productId} MISSING from offers_by_product`);
          if (REPAIR) {
            await bulkUpdateOffers(s.id, {}, { offersByProductOps: [{ op: "SADD", productId: o.productId, member }] });
            productIndexCache.get(o.productId)!.add(member);
          }
        }
      }
    }
  }

  console.log(`Mode: ${REPAIR ? "REPAIR (writes SADD only, idempotent)" : "DETECT ONLY (zero writes)"}`);
  console.log(`Checked ${checked} resolved offers.`);
  console.log(`Missing from offers_by_reference_product: ${missingFromRefIndex}${REPAIR ? " (repaired)" : ""}`);
  console.log(`Missing from offers_by_product: ${missingFromProductIndex}${REPAIR ? " (repaired)" : ""}`);
  examples.slice(0, 20).forEach((e) => console.log(`  ${e}`));
}
main();
