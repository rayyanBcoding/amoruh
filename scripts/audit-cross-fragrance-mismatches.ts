// READ-ONLY. Two things:
// 1. Confirms whether TODAY's automated matcher (matchSupplierRow) would
//    reproduce the Dior Homme -> Miss Dior false link if that row were
//    processed fresh right now.
// 2. Catalog-wide bulk audit for the same CLASS of problem: two or more
//    currently-linked offers on one Master Product that share brand +
//    size + concentration but have near-zero core-fragrance-name token
//    overlap (a strong signal of two different flankers/fragrances
//    incorrectly unified under one identity).
// No writes.
import { getCommittedOffers, getAllReferenceProducts } from "../src/lib/pricing-db";
import { getSuppliers } from "../src/lib/intake-db";
import { getProducts } from "../src/lib/db";
import {
  extractAttributes,
  resolveEffectiveBrand,
  matchSupplierRow,
  tokenSetSimilarity,
  buildMasterCandidatePool,
  buildBrandBucketedPool,
} from "../src/lib/pricing-matching";
import type { SupplierOfferCurrent } from "../src/lib/pricing-types";

async function main() {
  const suppliers = await getSuppliers();
  const [products, referenceProducts] = await Promise.all([getProducts(), getAllReferenceProducts()]);

  console.log("=== Part 1: would TODAY's matcher create the Dior Homme -> Miss Dior link? ===");
  const diorHommeRow = {
    offerKey: "sku:01cd10048000002-010020-0125cfr",
    supplierSku: "01cd10048000002-010020-0125cfr",
    description: "CHRISTIAN DIOR DIOR HOMME (M) PARFUM 125 ml FR",
    brand: "CHRISTIAN DIOR",
    upc: "3348901755504",
    ean: "",
  };
  const pool = buildBrandBucketedPool(buildMasterCandidatePool(products, referenceProducts));
  const fresh = matchSupplierRow(diorHommeRow, products, [], referenceProducts, pool);
  console.log(`Fresh match result: reviewStatus=${fresh.reviewStatus} matchType=${fresh.matchType} matchConfidence=${fresh.matchConfidence}`);
  console.log(`  candidateProductId=${fresh.candidateProductId} candidateReferenceProductId=${fresh.candidateReferenceProductId} referenceProductId=${fresh.referenceProductId} productId=${fresh.productId}`);
  const missDiorId = "refprod_1789344177599_3vyi1u";
  const wouldLinkToMissDior = fresh.referenceProductId === missDiorId || fresh.candidateReferenceProductId === missDiorId;
  console.log(`Would this incorrectly resolve to the Miss Dior Master Product today? ${wouldLinkToMissDior ? "*** YES -- STILL A LIVE BUG ***" : "NO -- today's matcher correctly rejects/separates this"}`);
  if (fresh.competingCandidates) {
    console.log(`  competingCandidates: ${JSON.stringify(fresh.competingCandidates)}`);
  }

  console.log("\n=== Part 2: catalog-wide bulk audit for the same class of problem ===");
  const offersBySupplier = await Promise.all(suppliers.map((s) => getCommittedOffers(s.id)));
  const referenceProductById = new Map(referenceProducts.map((rp) => [rp.id, rp]));
  const productById = new Map(products.map((p) => [p.id, p]));

  interface GroupedOffer {
    supplierId: string;
    offerKey: string;
    description: string;
    brand: string;
    coreTokens: string[];
    sizeMl: number | null;
    concentration: string | null;
    matchType: string;
    matchConfidence: number | null;
  }
  const groups = new Map<string, GroupedOffer[]>();

  for (let i = 0; i < suppliers.length; i++) {
    for (const o of Object.values(offersBySupplier[i]) as SupplierOfferCurrent[]) {
      if (o.currentlyListed === false) continue;
      if (o.reviewStatus !== "auto_matched" && o.reviewStatus !== "confirmed") continue;
      const identity = o.productId ?? o.referenceProductId;
      if (!identity) continue;
      const effectiveBrand = resolveEffectiveBrand({ brand: o.brand, description: o.description }, products, referenceProducts);
      const attrs = extractAttributes(`${o.brand} ${o.description}`, effectiveBrand);
      // Bare-decimal size tokens (Miami's "1.7"/"3.4" fl-oz convention,
      // preserved by contentTokens() by design elsewhere in this
      // codebase) can survive into coreNameTokens as residual digits
      // that don't distinguish the actual fragrance name -- exclude
      // pure-numeric tokens here so a leftover size digit never
      // masquerades as a "different fragrance name" signal.
      const meaningfulTokens = attrs.coreNameTokens.filter((t) => !/^\d+(\.\d+)?$/.test(t));
      if (!groups.has(identity)) groups.set(identity, []);
      groups.get(identity)!.push({
        supplierId: suppliers[i].id,
        offerKey: o.offerKey,
        description: o.description,
        brand: effectiveBrand,
        coreTokens: meaningfulTokens,
        sizeMl: attrs.sizeMl,
        concentration: attrs.concentration,
        matchType: o.matchType,
        matchConfidence: o.matchConfidence,
      });
    }
  }

  console.log(`Identities with 2+ currently-linked resolved offers: ${[...groups.values()].filter((g) => g.length >= 2).length}`);

  const CORE_NAME_SIMILARITY_FLOOR = 0.3; // below this, treat as "different fragrance name"
  const flagged: { identity: string; label: string; rows: GroupedOffer[] }[] = [];

  for (const [identity, rows] of groups) {
    if (rows.length < 2) continue;
    // Only compare rows that agree on brand + size + concentration
    // (both non-null) -- the exact shape of the reported bug.
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        if (a.brand.toLowerCase() !== b.brand.toLowerCase()) continue;
        if (a.sizeMl === null || b.sizeMl === null || a.sizeMl !== b.sizeMl) continue;
        if (!a.concentration || !b.concentration || a.concentration !== b.concentration) continue;
        const sim = tokenSetSimilarity(a.coreTokens, b.coreTokens);
        if (sim < CORE_NAME_SIMILARITY_FLOOR) {
          const rp = referenceProductById.get(identity);
          const p = productById.get(identity);
          const label = rp ? `${rp.brand} ${rp.name}` : p ? `${p.brand} ${p.name}` : identity;
          flagged.push({ identity, label, rows: [a, b] });
        }
      }
    }
  }

  console.log(`\nFlagged identity pairs (brand+size+concentration match, core-name similarity < ${CORE_NAME_SIMILARITY_FLOOR}): ${flagged.length}`);

  // Tally by matchType of the two offending rows -- distinguishes
  // "these were manually linked, historical" from "the live automated
  // matcher itself produced this."
  const matchTypeTally = new Map<string, number>();
  for (const f of flagged) {
    for (const r of f.rows) {
      const key = r.matchType;
      matchTypeTally.set(key, (matchTypeTally.get(key) ?? 0) + 1);
    }
  }
  console.log(`\nmatchType tally across all flagged rows (${flagged.length * 2} row-slots):`);
  for (const [type, count] of [...matchTypeTally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${type}: ${count}`);

  const distinctIdentities = new Set(flagged.map((f) => f.identity)).size;
  console.log(`Distinct affected Master Products: ${distinctIdentities}`);

  for (const f of flagged.slice(0, 60)) {
    console.log(`\n  Master Product: ${f.label} (${f.identity})`);
    for (const r of f.rows) {
      console.log(`    [${r.supplierId}] ${r.offerKey} matchType=${r.matchType} confidence=${r.matchConfidence}: "${r.description}" coreTokens=${JSON.stringify(r.coreTokens)}`);
    }
  }
  if (flagged.length > 60) console.log(`\n  ... and ${flagged.length - 60} more (truncated for report length)`);
}
main();
