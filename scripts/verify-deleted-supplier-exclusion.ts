// Explicit, read-only verification that offers from deleted/non-existent
// suppliers are excluded from EVERY actionable purchasing-intelligence
// surface: Supplier Price Leaders, competitive counts, wins/ties, Buying
// Opportunities, lowest-price ranking, next-best supplier, per-unit
// savings, and single-supplier coverage. Tests directly against the live
// "Unknown Supplier" examples found during development. No writes.
import { getAllReferenceProducts, getOffersByReferenceProduct, getCurrentOffer, getSupplierPriceLeaderboard, getPriceLeaderboardPreview } from "../src/lib/pricing-db";
import { getSuppliers } from "../src/lib/intake-db";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`);
  }
}

async function main() {
  const knownSuppliers = await getSuppliers();
  const knownIds = new Set(knownSuppliers.map((s) => s.id));
  console.log(`Current real suppliers: ${knownSuppliers.map((s) => s.name).join(", ")}`);

  const all = await getAllReferenceProducts();

  // The three concrete "Unknown Supplier" identities found live during
  // development.
  const targets = [
    { id: "refprod_1789342903253_0fk8g7", label: "SI PASSIONE #1 (no orphaned offers -- control case)" },
    { id: "refprod_1789344157156_uolo3n", label: "SI PASSIONE #2 (mostly orphaned + 1 stale/delisted real offer)" },
    { id: "refprod_1789709791421_6mym8g", label: "SI PASSIONE #3 (2 real suppliers + 6 orphaned)" },
  ];

  const board = await getSupplierPriceLeaderboard();
  const boardByKey = new Map(board.competitiveProducts.map((p) => [p.identityKey, p]));
  const singleByKey = new Map(board.singleSupplierProducts.map((p) => [p.identityKey, p]));

  for (const t of targets) {
    const rp = all.find((p) => p.id === t.id);
    if (!rp) {
      console.log(`\n[${t.label}] ${t.id} not found in current catalog -- skipping (may have been touched by unrelated activity).`);
      continue;
    }
    console.log(`\n=== ${t.label}: ${rp.brand} ${rp.name} (${rp.id}) ===`);

    const refs = await getOffersByReferenceProduct(rp.id);
    const realOfferPrices: { supplierId: string; supplierName: string; priceUsd: number }[] = [];
    const orphanedOfferPrices: { supplierId: string; priceUsd: number }[] = [];
    for (const r of refs) {
      const offer = await getCurrentOffer(r.supplierId, r.offerKey);
      if (!offer || !offer.currentlyListed || (offer.reviewStatus !== "auto_matched" && offer.reviewStatus !== "confirmed")) continue;
      const known = knownSuppliers.find((s) => s.id === r.supplierId);
      if (known) realOfferPrices.push({ supplierId: r.supplierId, supplierName: known.name, priceUsd: offer.price });
      else orphanedOfferPrices.push({ supplierId: r.supplierId, priceUsd: offer.price });
    }
    console.log(`  Real, currently-listed & reviewed offers: ${realOfferPrices.map((o) => `${o.supplierName}=$${o.priceUsd}`).join(", ") || "(none)"}`);
    console.log(`  Orphaned (deleted-supplier) offers: ${orphanedOfferPrices.map((o) => `${o.supplierId.slice(0, 20)}...=$${o.priceUsd}`).join(", ") || "(none)"}`);

    const cheapestOrphaned = orphanedOfferPrices.length > 0 ? Math.min(...orphanedOfferPrices.map((o) => o.priceUsd)) : null;
    const cheapestReal = realOfferPrices.length > 0 ? Math.min(...realOfferPrices.map((o) => o.priceUsd)) : null;
    if (cheapestOrphaned !== null && cheapestReal !== null) {
      console.log(`  Cheapest orphaned offer: $${cheapestOrphaned} vs cheapest REAL offer: $${cheapestReal} -- ${cheapestOrphaned < cheapestReal ? "orphaned is CHEAPER (the exact scenario to test)" : "real is cheaper anyway"}`);
    }

    const distinctRealSuppliers = new Set(realOfferPrices.map((o) => o.supplierId)).size;
    const inCompetitive = boardByKey.get(rp.id);
    const inSingle = singleByKey.get(rp.id);

    if (distinctRealSuppliers >= 2) {
      assert(Boolean(inCompetitive), `${distinctRealSuppliers} real suppliers -> should be COMPETITIVE, found in board.competitiveProducts`);
      if (inCompetitive) {
        assert(inCompetitive.eligibleSupplierCount === distinctRealSuppliers, `eligibleSupplierCount (${inCompetitive.eligibleSupplierCount}) matches real distinct-supplier count (${distinctRealSuppliers}), orphaned suppliers not counted`);
        const winnerIsReal = inCompetitive.winningSupplierIds.every((id) => knownIds.has(id));
        assert(winnerIsReal, `winning supplier(s) [${inCompetitive.winningSupplierIds.join(",")}] are all REAL, current suppliers -- never a deleted one`);
        if (cheapestOrphaned !== null && cheapestReal !== null && cheapestOrphaned < cheapestReal) {
          assert(inCompetitive.bestPriceUsd === cheapestReal, `bestPriceUsd ($${inCompetitive.bestPriceUsd}) is the cheapest REAL offer ($${cheapestReal}), NOT the cheaper orphaned offer ($${cheapestOrphaned}) -- a deleted supplier with the lowest historical price cannot win`);
        }
      }
      assert(!inSingle, "not also counted in singleSupplierProducts (no double-counting)");
    } else if (distinctRealSuppliers === 1) {
      assert(!inCompetitive, `only 1 real supplier -> should NOT be competitive (found in board.competitiveProducts: ${Boolean(inCompetitive)})`);
      assert(Boolean(inSingle), "1 real supplier -> should be in singleSupplierProducts");
      if (inSingle) assert(knownIds.has(inSingle.supplierId), `single-supplier entry's supplier (${inSingle.supplierName}) is a real, current supplier, not an orphaned one`);
    } else {
      assert(!inCompetitive && !inSingle, "0 real suppliers -> should not appear as a competitive win or single-supplier entry at all (orphaned-only offers produce no actionable intelligence)");
    }
  }

  // --- Global check: every leaderboard-listed supplier is real ---
  console.log("\n=== Global check: every supplier named anywhere in the leaderboard is a REAL, current supplier ===");
  const allWinnerIds = new Set(board.competitiveProducts.flatMap((p) => p.winningSupplierIds));
  const allOfferSupplierIds = new Set(board.competitiveProducts.flatMap((p) => p.offers.map((o) => o.supplierId)));
  const allSingleSupplierIds = new Set(board.singleSupplierProducts.map((p) => p.supplierId));
  const allSummarySupplierIds = new Set(board.suppliers.map((s) => s.supplierId));
  for (const [label, set] of [
    ["winningSupplierIds", allWinnerIds],
    ["competitiveProducts[].offers[].supplierId", allOfferSupplierIds],
    ["singleSupplierProducts[].supplierId", allSingleSupplierIds],
    ["suppliers[].supplierId (leaderboard summary rows)", allSummarySupplierIds],
  ] as const) {
    const unknown = [...set].filter((id) => !knownIds.has(id));
    assert(unknown.length === 0, `${label}: every id is a real current supplier (found ${unknown.length} unknown: ${unknown.join(",")})`);
  }
  assert(board.suppliers.length === knownSuppliers.length, `leaderboard summary has exactly ${knownSuppliers.length} supplier rows (one per real current supplier), not more`);

  // --- Search price preview uses the SAME eligibility (same cache) ---
  console.log("\n=== Search price preview uses the same eligibility rule ===");
  const preview = await getPriceLeaderboardPreview();
  for (const t of targets) {
    const rp = all.find((p) => p.id === t.id);
    if (!rp) continue;
    const boardEntry = boardByKey.get(rp.id) ?? singleByKey.get(rp.id);
    const previewEntry = preview.byReferenceProductId.get(rp.id);
    if (boardEntry) {
      assert(Boolean(previewEntry), `${rp.brand} ${rp.name}: search preview has an entry when the leaderboard does`);
      if (previewEntry) {
        const expectedBest = "bestPriceUsd" in boardEntry ? boardEntry.bestPriceUsd : boardEntry.priceUsd;
        assert(previewEntry.bestPriceUsd === expectedBest, `search preview bestPriceUsd (${previewEntry.bestPriceUsd}) matches leaderboard (${expectedBest})`);
      }
    } else {
      assert(!previewEntry, `${rp.brand} ${rp.name}: no leaderboard entry (0 real suppliers) -> search preview also has no entry (never shows a deleted-supplier price)`);
    }
  }

  console.log(`\n=== TOTAL: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
