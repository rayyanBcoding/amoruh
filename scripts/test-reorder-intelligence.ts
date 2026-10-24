// LIVE Reorder Intelligence — scoring rules + end-to-end behaviour against the
// REAL sale code (record / edit / cancel / restore).
//
// HERMETIC: the app's Redis is the in-memory FakeRedis (real Lua via fengari)
// injected through globalThis.__amoruhRedis; no production data is touched.
//   npx tsx scripts/test-reorder-intelligence.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { installFakeRedis } from "./support/fake-redis";

const fake = installFakeRedis();

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.log(`FAIL: ${label}\n   expected ${JSON.stringify(expected)}\n   got      ${JSON.stringify(actual)}`);
  }
}
const ok = (label: string, cond: boolean) => check(label, cond, true);
const section = (name: string) => console.log(`\n${name}`);

async function main() {
  const intel = await import("../src/lib/reorder-intelligence");
  const cfg = await import("../src/lib/reorder-config");
  const { computeReorderIntelligence, drilldownForProduct, percentileRanks, consistencyConfidence, sessionsInWindow } = intel;

  // ---------------------------------------------------------------------
  section("A. Pure scoring rules");
  const NOW = new Date("2026-10-23T12:00:00Z");
  const sess = (n: number) => ({ id: `s${n}`, name: `LIVE ${n}`, startedAt: new Date(Date.UTC(2026, 9, 1 + n * 3)).toISOString() }); // 3 days apart
  const SESSIONS = Array.from({ length: 8 }, (_, i) => sess(i + 1));
  let sid = 0;
  const sale = (session: number, productId: string, price: number, cost: number | null, qty = 1, status = "completed") => ({
    saleId: `sale_${++sid}`, sessionId: `s${session}`, productId, quantity: qty, price, landedCostAtSale: cost,
    soldAt: new Date(Date.UTC(2026, 9, 1 + session * 3, 20)).toISOString(), status, liveOrderNumber: sid,
  });
  const catalog = (ids: string[], stock: Record<string, number> = {}) =>
    ids.map((id) => ({ id, brand: "B", name: id, size: "100ml", sku: `SKU-${id}`, barcode: `BC-${id}`, inventory: stock[id] ?? 0 }));
  const run = (sales: ReturnType<typeof sale>[], ids: string[], window: any = "all", stock: Record<string, number> = {}) =>
    computeReorderIntelligence({ sessions: SESSIONS, sales, products: catalog(ids, stock), window, now: NOW });
  const rowOf = (res: ReturnType<typeof run>, id: string) => res.rows.find((r) => r.productId === id)!;

  check("percentile ranks: ties share a rank, extremes are 0 and 100", percentileRanks([1, 2, 2, 10]), [0, 50, 50, 100]);
  check("consistency confidence ramps 1 LIVE low → 4+ LIVEs full", [1, 2, 3, 4, 9].map(consistencyConfidence), [0.35, 0.6, 0.8, 1, 1]);

  // Product A: sold once, one big profit. Product B: sold in 6 of the last 7 LIVEs at ~$20 each.
  const aSales = [sale(2, "A", 150, 100, 1)]; // $50 profit, once
  const bSales = [1, 2, 3, 5, 6, 7].map((n) => sale(n, "B", 50, 30)); // $20 profit x6 = $120
  const filler = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => sale(n, "F", 40, 35)); // keeps the population realistic
  const ab = run([...aSales, ...bSales, ...filler], ["A", "B", "F"]);
  const A = rowOf(ab, "A");
  const B = rowOf(ab, "B");
  check("B (6 of 8 applicable LIVEs) is far more consistent than A", [B.livesSold, B.applicableLives, A.livesSold, A.applicableLives], [6, 8, 1, 7]);
  ok("B's consistency beats A's by a wide margin", B.consistency > A.consistency + 40);
  check("A (one sale) is 'New / Not Enough Data' — no confident recommendation", [A.bucket, A.suggestedQty], ["New / Not Enough Data", 0]);
  ok("B outranks A on Reorder Score", B.score > A.score);
  const brandNew = run([...filler, sale(8, "N", 50, 30)], ["F", "N"]);
  check("a product first sold in the newest LIVE has low-confidence consistency (1 LIVE of history)", [rowOf(brandNew, "N").applicableLives, rowOf(brandNew, "N").confidence], [1, "low"]);
  check("…and 2–3 LIVEs of history is medium", run([...filler, sale(7, "M", 50, 30)], ["F", "M"]).rows.find((r) => r.productId === "M")!.confidence, "medium");
  check("…4+ LIVEs of history is full", A.confidence, "full");

  // Weights: demand 40 / profit 35 / consistency 25, summing to 1
  check("score weights are 40/35/25", [cfg.SCORE_WEIGHTS.demand, cfg.SCORE_WEIGHTS.profit, cfg.SCORE_WEIGHTS.consistency], [0.4, 0.35, 0.25]);
  const bd = B.breakdown;
  const expected = bd.weights.demand * bd.demand + bd.weights.profit * (bd.profit as number) + bd.weights.consistency * bd.consistency;
  ok("score = the weighted sum of its shown components (explainable, rounding only)", Math.abs(B.score - expected) <= 1);

  // ---- Cost Unknown: profit left out, Demand + Consistency re-weighted proportionally
  const cu = run([...[1, 2, 3, 4].map((n) => sale(n, "U", 30, null)), ...[1, 2, 3, 4].map((n) => sale(n, "K", 30, 20))], ["U", "K"]);
  const U = rowOf(cu, "U");
  check("no recorded cost → Cost Unknown bucket", U.bucket, "Cost Unknown");
  check("profit is not treated as $0: it is unknown", [U.profit, U.profitPerUnit, U.margin, U.breakdown.profit], [null, null, null, null]);
  check("weights re-scaled to demand 40/65 and consistency 25/65", [Math.round(U.breakdown.weights.demand * 1000) / 1000, U.breakdown.weights.profit, Math.round(U.breakdown.weights.consistency * 1000) / 1000], [0.615, 0, 0.385]);
  ok("a visible lower-confidence warning is attached", U.warnings.some((w) => /Cost unknown/.test(w)));
  const uScore = U.breakdown.weights.demand * U.breakdown.demand + U.breakdown.weights.consistency * U.breakdown.consistency;
  ok("its score is built from Demand + Consistency only", Math.abs(U.score - uScore) <= 1);
  check("unknown-cost sales are excluded from total profit, and counted", [cu.summary.totalProfit, cu.summary.salesMissingCost], [40, 4]);

  // ---- Negative-profit guardrail
  const loser = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [sale(n, "L", 20, 24), sale(n, "L", 20, 24)]); // 16 units, loses $4 each
  const winners = [1, 2, 3, 4].map((n) => sale(n, "W", 60, 30));
  const lg = run([...loser, ...winners, ...filler], ["L", "W", "F"]);
  const L = rowOf(lg, "L");
  check("a high-demand loser is 'High Demand / Losing Money', never Hot", L.bucket, "High Demand / Losing Money");
  ok("its score is capped below the top of the list", L.score <= cfg.LOSING_MONEY_SCORE_CAP && L.breakdown.capped);
  check("it gets no reorder suggestion and never counts as a reorder candidate", [L.suggestedQty, intel.isReorderCandidate(L)], [0, false]);
  ok("the warning tells the host what to do about it", L.warnings.some((w) => /supplier cost|auction floor/i.test(w)));
  ok("it never appears in the Top Reorder Candidates", !lg.summary.topCandidates.some((r) => r.productId === "L"));
  ok("…even though it has the most units", L.units > rowOf(lg, "W").units);

  // ---- Hot + Profitable thresholds
  const W = rowOf(lg, "W");
  ok("a consistent, profitable product can be Hot + Profitable or Steady", ["Hot + Profitable", "Steady Seller", "High Profit / Lower Frequency"].includes(W.bucket) || W.bucket === "High Demand / Thin Margin");

  // ---- Windows
  check("Last 3 LIVEs = the 3 newest sessions", sessionsInWindow(SESSIONS, "last3", NOW).map((s) => s.id), ["s6", "s7", "s8"]);
  check("Last 5 / Last 10 / All", [sessionsInWindow(SESSIONS, "last5", NOW).length, sessionsInWindow(SESSIONS, "last10", NOW).length, sessionsInWindow(SESSIONS, "all", NOW).length], [5, 8, 8]);
  check("Last 7 days uses the session start time (cutoff Oct 16 12:00)", sessionsInWindow(SESSIONS, "7d", NOW).map((s) => s.id), ["s6", "s7", "s8"]);
  check("Last 30 days covers everything here", sessionsInWindow(SESSIONS, "30d", NOW).length, 8);
  const allSales = [...aSales, ...bSales, ...filler];
  const last3 = run(allSales, ["A", "B", "F"], "last3");
  check("a windowed run only counts sales inside the window", rowOf(last3, "B").units, 2); // B sold in s6, s7 within last3 (s6..s8)
  check("…and 'applicable LIVEs' is measured inside the window", [rowOf(last3, "B").livesSold, rowOf(last3, "B").applicableLives], [2, 3]);
  check("a product with no sales in the window is absent", last3.rows.some((r) => r.productId === "A"), false);
  check("window recalculates the summary (3 LIVEs: B 2 units + F 3 units)", [last3.summary.sessionsInWindow, last3.summary.totalUnits], [3, 5]);

  // ---- Canonical product identity: no fuzzy merge, look-alikes only reported
  const twin = computeReorderIntelligence({
    sessions: SESSIONS,
    sales: [sale(1, "P1", 50, 30), sale(2, "P1", 50, 30), sale(3, "P2", 50, 30)],
    products: [
      { id: "P1", brand: "Creed", name: "Aventus", size: "100ml", sku: "1", barcode: "1", inventory: 0 },
      { id: "P2", brand: "Creed", name: "Aventus *NEW*", size: "100ml", sku: "2", barcode: "2", inventory: 0 },
    ],
    window: "all",
    now: NOW,
  });
  check("different product ids stay separate rows (no fuzzy merge)", twin.rows.map((r) => r.productId).sort(), ["P1", "P2"]);
  check("…and are reported as a data-quality look-alike group", twin.dataQuality.lookAlikeGroups.map((g) => g.productIds.sort()), [["P1", "P2"]]);

  // ---- Suggested quantity (H is the clear leader in a population of weak peers)
  const peers = ["P1", "P2", "P3", "P4", "P5", "P6"].map((id) => sale(1, id, 20, 18));
  const hSales = [1, 2, 3, 4].map((n) => sale(n, "H", 90, 20, 3));
  const ids = ["H", "P1", "P2", "P3", "P4", "P5", "P6"];
  const withStock = run([...hSales, ...peers], ids, "all", { H: 2 });
  const H = rowOf(withStock, "H");
  ok("suggested qty = avg units/LIVE × horizon × consistency factor − stock, capped at units sold", H.suggestedQty > 0 && H.suggestedQty <= H.units);
  ok("the reasoning string shows the arithmetic", /units\/LIVE × 4 expected LIVEs/.test(H.suggestedReason) && /minus 2 in stock/.test(H.suggestedReason));
  check("strong seller with 2 left is flagged", /only 2 remaining/.test(H.flag ?? ""), true);
  const out = run([...hSales, ...peers], ids, "all", { H: 0 });
  check("out of stock strong seller is flagged", rowOf(out, "H").flag, "Strong seller — currently out of stock");
  const plenty = run([...hSales, ...peers], ids, "all", { H: 50 });
  check("plenty of stock → nothing to reorder", rowOf(plenty, "H").suggestedQty, 0);

  // ---------------------------------------------------------------------
  section("B. End to end through the real sale code (record / edit / cancel / restore)");
  const { KEYS: Core } = await import("../src/lib/kv");
  const { KEYS: Intake } = await import("../src/lib/intake-db");
  const sales = await import("../src/lib/sales-analytics");
  const live = await import("../src/lib/live-db");
  const { getReorderIntelligence, getProductDrilldown } = await import("../src/lib/reorder-db");

  const product = (id: string, name: string, inventory: number, cost: number) => ({
    id, sku: `SKU-${id}`, barcode: `BC-${id}`, brand: "Brand", name, size: "100ml", concentration: "EDP", image: "", color: "#000", cost,
    retailPrice: 0, marketPrice: 0, lootPrice: 0, minPrice: 0, topNotes: [], middleNotes: [], baseNotes: [], projection: "", longevity: "",
    description: "", condition: "New", shelf: "", inventory, authentic: true, tiktokListing: "", status: "active",
  });
  const lot = (id: string, productId: string, unitCost: number, qty: number) => ({
    id, poId: `po_${productId}`, poNumber: "1", poLineId: `pol_${productId}`, productId, supplierId: "s", supplierName: "S",
    unitCost, receivedQuantity: qty, receivedDate: "2026-10-01T00:00:00.000Z", invoiceDate: "2026-10-01",
  });
  const recv = (lotId: string, productId: string, qty: number) => ({
    id: `txn_${lotId}`, productId, poId: `po_${productId}`, poLineId: `pol_${productId}`, lotId, quantityDelta: qty, reason: "receiving",
    receivingEventId: null, saleId: null, operator: "x", timestamp: "2026-10-01T00:00:00.000Z",
  });
  await fake.set(Core.products, [product("pA", "Alpha", 50, 99), product("pB", "Bravo", 50, 99)]);
  await fake.set(Intake.lots("pA"), [lot("lotA", "pA", 30, 50)]);
  await fake.set(Intake.lots("pB"), [lot("lotB", "pB", 40, 50)]);
  await fake.set(Intake.inventoryTransactions, [recv("lotA", "pA", 50), recv("lotB", "pB", 50)]);
  await fake.set(Intake.pos, [{ id: "po_pA", shippingCost: 0, totalExpectedQty: 50 }, { id: "po_pB", shippingCost: 0, totalExpectedQty: 50 }]);

  let n = 0;
  const uid = () => `k${++n}`;
  const op = "Tester";
  const rec = (sessionId: string, productId: string, bid: number, qty = 1) =>
    sales.recordSale({ liveSessionId: sessionId, productId, quantity: qty, winningBid: bid, operator: op, idempotencyKey: uid() });
  const perf = async (w: any = "all") => {
    const res = await getReorderIntelligence(w);
    return { res, a: res.rows.find((r) => r.productId === "pA"), b: res.rows.find((r) => r.productId === "pB") };
  };

  // pA sells in all three LIVEs, pB in two. Ended Lives are read-only, so the edit /
  // cancel / restore steps below run in the ACTIVE Live; a sale canceled before its Live ended
  // proves canceled orders stay out of older sessions too.
  const live1 = (await live.startLiveSession("LIVE One", op)).id;
  await rec(live1, "pA", 50);
  await rec(live1, "pB", 60);
  await live.endLiveSession(live1);
  await new Promise((r) => setTimeout(r, 5));
  const live2 = (await live.startLiveSession("LIVE Two", op)).id;
  await rec(live2, "pA", 55);
  await rec(live2, "pB", 70);
  const gone = await rec(live2, "pA", 33);
  await sales.cancelSale({ saleId: gone.saleId, operator: op, idempotencyKey: uid() });
  await live.endLiveSession(live2);
  await new Promise((r) => setTimeout(r, 5));
  const live3 = (await live.startLiveSession("LIVE Three", op)).id; // stays active
  const a3 = await rec(live3, "pA", 45);

  const first = await perf();
  let { res, a } = first;
  const b = first.b;
  check("a sale canceled in an ended LIVE is excluded (not counted as a unit, GMV, cost or LIVE sold)", [a?.units, a?.gmv, a?.livesSold], [3, 150, 3]);
  check("the same canonical product aggregates across multiple LIVE sessions", [a?.units, a?.livesSold, a?.applicableLives], [3, 3, 3]);
  check("historical cost-at-sale (lot cost 30), NOT today's product cost (99), drives profit", [a?.avgUnitCost, a?.profit], [30, 60]);
  check("pB: two LIVEs, profit uses its own cost 40", [b?.units, b?.livesSold, b?.profit], [2, 2, 50]);

  // --- reconcile to the underlying SaleRecords
  const { loadLiveHistory } = await import("../src/lib/reorder-db");
  const hist = await loadLiveHistory();
  const activeRows = hist.sales.filter((s) => s.status !== "canceled");
  check("product rows reconcile to the active SaleRecords (units)", res.rows.reduce((s, r) => s + r.units, 0), activeRows.reduce((s, x) => s + x.quantity, 0));
  check("product rows reconcile to the active SaleRecords (GMV)", res.rows.reduce((s, r) => s + r.gmv, 0), activeRows.reduce((s, x) => s + x.price, 0));
  const sessionStatsRevenue = (await Promise.all([live1, live2, live3].map((id) => live.getSessionStats(id)))).reduce((s, x) => s + x.revenue, 0);
  check("…and to the sum of the per-session Live stats", res.summary.totalGmv, sessionStatsRevenue);
  check("…and total profit matches the cost snapshots on the records", res.summary.totalProfit, activeRows.reduce((s, x) => s + (x.price - (x.landedCostAtSale as number) * x.quantity), 0));

  // --- edited price changes profit immediately
  await sales.editSale({ saleId: a3.saleId, newPrice: 75, operator: op, idempotencyKey: uid() });
  ({ res, a } = await perf());
  check("editing a price changes profit and GMV at once (+30)", [a?.gmv, a?.profit], [180, 90]);
  check("…and the avg selling price follows", a?.avgSellingPrice, 60);

  // --- cancel excludes everywhere; restore brings it back (active Live)
  const a4 = await rec(live3, "pA", 40);
  const before = (await perf()).a!;
  await sales.cancelSale({ saleId: a4.saleId, operator: op, idempotencyKey: uid() });
  const mid = (await perf()).a!;
  check("cancel removes the order from units / GMV / profit", [mid.units, mid.gmv, mid.profit], [before.units - 1, before.gmv - 40, before.profit! - 10]);
  check("…and from the drill-down", (await getProductDrilldown("pA", "all")).sessions.find((x) => x.sessionName === "LIVE Three")?.orders.length, 1);
  await sales.restoreSale({ saleId: a4.saleId, operator: op, idempotencyKey: uid() });
  const after = (await perf()).a!;
  check("restore returns it, with its original cost snapshot", [after.units, after.gmv, after.profit], [before.units, before.gmv, before.profit]);
  // canceling the ONLY order of a LIVE removes that LIVE from the product's consistency
  const only = await rec(live3, "pB", 90);
  const bWith = (await perf()).b!;
  await sales.cancelSale({ saleId: only.saleId, operator: op, idempotencyKey: uid() });
  const bWithout = (await perf()).b!;
  check("canceling a product's only order in a LIVE drops that LIVE from consistency", [bWith.livesSold, bWithout.livesSold], [3, 2]);

  // --- supplier / today's cost never rewrite history
  const products = (await fake.get<any[]>(Core.products)) as any[];
  await fake.set(Core.products, products.map((p) => ({ ...p, cost: 1, ...(p.id === "pA" ? { cost: 500 } : {}) })));
  const repriced = (await perf()).a!;
  check("changing today's product cost does not move historical profit", [repriced.profit, repriced.avgUnitCost], [after.profit, after.avgUnitCost]);
  // lot cost changes later (new stock at a different price) must not touch old sales either
  await fake.set(Intake.lots("pA"), [lot("lotA", "pA", 30, 50), { ...lot("lotA2", "pA", 80, 50), receivedDate: "2026-10-22T00:00:00.000Z" }]);
  check("receiving newer, pricier stock does not rewrite historical profit", (await perf()).a!.profit, after.profit);
  const drill = await getProductDrilldown("pA", "all");
  check("the drill-down keeps each sale's own cost snapshot", drill.sessions.every((s) => s.avgUnitCost === 30), true);
  ok("the supplier cost block is separate forward-looking data (null here: no offers)", drill.supplier !== null && drill.supplier.bestSupplierCostUsd === null && drill.supplier.expectedProfitPerUnit === null);

  // --- drill-down matches the table
  const dd = drilldownForProduct({ productId: "pA", sessions: hist.sessions, sales: (await loadLiveHistory()).sales, window: "all" });
  check("drill-down units sum to the product's units", dd.reduce((s, x) => s + x.units, 0), (await perf()).a!.units);
  check("drill-down is newest LIVE first", dd.map((x) => x.sessionName)[0], "LIVE Three");

  // ---------------------------------------------------------------------
  section("C. Forward-looking guidance for High Demand / Losing Money (never rewrites history)");
  const { maxBuyCostFor, forwardLookingFor, applySupplierCosts } = intel;
  check("target gross margin is configurable and starts at 15%", cfg.TARGET_GROSS_MARGIN, 0.15);
  check("max buy cost = historical avg sale × (1 − target margin)", maxBuyCostFor(26.2), 22.27);
  check("…and follows a different target margin", maxBuyCostFor(100, 0.3), 70);

  // a Hawas-Ice-like product: sells a lot at ~$26, historically loses money at a ~$27 cost
  const hawas = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [sale(n, "HW", 26, 27), sale(n, "HW", 26, 27)]); // 16 units, −$1 each
  const peersC = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"].map((id) => sale(1, id, 20, 10));
  const idsC = ["HW", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6"];
  const baseC = run([...hawas, ...peersC], idsC);
  const HW = rowOf(baseC, "HW");
  check("historically: High Demand / Losing Money, no forward block yet", [HW.bucket, HW.forward], ["High Demand / Losing Money", null]);
  check("every row already carries the transparent max buy cost", HW.maxBuyCost, 22.1);

  const withCost = (cost: number | null, name: string | null = "Acme") => applySupplierCosts(baseC, new Map([["HW", { costUsd: cost, supplierName: name }]]));
  const good = rowOf(withCost(18), "HW");
  check("a supplier cost that makes it profitable → 'Buy Only at the Right Cost'", good.bucket, "High Demand — Buy Only at the Right Cost");
  check("projected profit/unit and margin at the supplier cost (avg sale 26)", [good.forward?.projectedProfitPerUnit, Math.round((good.forward?.projectedMargin ?? 0) * 1000) / 1000], [8, 0.308]);
  check("…meets the 15% target and shows the max buy cost", [good.forward?.meetsTargetMargin, good.forward?.maxBuyCost, good.forward?.status], [true, 22.1, "buy_only_at_right_cost"]);
  ok("…with a conditional reorder suggestion tied to the max buy cost", good.suggestedQty > 0 && /≤ \$22\.10/.test(good.suggestedReason));
  const thin = rowOf(withCost(24), "HW");
  check("profitable but above the max buy cost: still Buy-Only, flagged below target", [thin.bucket, thin.forward?.meetsTargetMargin], ["High Demand — Buy Only at the Right Cost", false]);
  const pricey = rowOf(withCost(30), "HW");
  check("a supplier cost above the selling price keeps it Losing Money", [pricey.bucket, pricey.forward?.status, pricey.suggestedQty], ["High Demand / Losing Money", "still_too_expensive", 0]);
  const none = rowOf(withCost(null), "HW");
  check("no actionable offer: stays Losing Money — 'wait for a better supplier cost'", [none.bucket, none.forward?.status, none.suggestedQty], ["High Demand / Losing Money", "no_offer", 0]);
  ok("…and says so in plain words", /wait for a better supplier cost/.test(none.forward?.message ?? ""));

  // history and score are byte-identical whatever the supplier says
  const HIST = (r: typeof HW) => ({ units: r.units, gmv: r.gmv, cost: r.cost, profit: r.profit, ppu: r.profitPerUnit, margin: r.margin, avg: r.avgSellingPrice, avgCost: r.avgUnitCost, score: r.score, breakdown: r.breakdown, lives: [r.livesSold, r.applicableLives], consistency: r.consistency });
  for (const [label, r] of [["profitable", good], ["thin", thin], ["too expensive", pricey], ["no offer", none]] as const) {
    check(`historical numbers + Reorder Score are unchanged (${label})`, HIST(r), HIST(HW));
  }
  check("the summary totals are unchanged by supplier guidance", [withCost(18).summary.totalProfit, withCost(18).summary.totalGmv], [baseC.summary.totalProfit, baseC.summary.totalGmv]);
  ok("a Buy-Only product is still never a Top Reorder Candidate", !withCost(18).summary.topCandidates.some((r) => r.productId === "HW"));
  check("forward projection helper agrees with the row (avg sale 26, cost 18)", forwardLookingFor({ avgSellingPrice: 26 }, 18, "Acme").projectedProfitPerUnit, 8);

  // end to end with the real sale code + an injected Pricing lookup
  await live.endLiveSession(live3);
  const fwdSessions: string[] = [];
  for (const nm of ["Forward 1", "Forward 2", "Forward 3"]) {
    await new Promise((r) => setTimeout(r, 5));
    const id = (await live.startLiveSession(nm, op)).id;
    fwdSessions.push(id);
    await fake.set(Core.products, [...((await fake.get<any[]>(Core.products)) ?? []).filter((p) => p.id !== "pX"), product("pX", "Xeno", 50, 99)]);
    if (nm === "Forward 1") {
      await fake.set(Intake.lots("pX"), [lot("lotX", "pX", 27, 50)]);
      await fake.set(Intake.inventoryTransactions, [...((await fake.get<any[]>(Intake.inventoryTransactions)) ?? []), recv("lotX", "pX", 50)]);
      await fake.set(Intake.pos, [...((await fake.get<any[]>(Intake.pos)) ?? []), { id: "po_pX", shippingCost: 0, totalExpectedQty: 50 }]);
    }
    await rec(id, "pX", 26);
    await rec(id, "pX", 26);
    await live.endLiveSession(id);
  }
  const rowX = async (lookup: any) => (await getReorderIntelligence("all", lookup)).rows.find((r) => r.productId === "pX")!;
  const beforeLookup = await rowX(async () => ({ costUsd: null, supplierName: null }));
  const afterLookup = await rowX(async () => ({ costUsd: 19, supplierName: "Acme" }));
  check("real sale history: 6 units, −$6, Losing Money before any supplier offer", [beforeLookup.units, beforeLookup.profit, beforeLookup.bucket], [6, -6, "High Demand / Losing Money"]);
  check("an offer at $19 makes it 'Buy Only at the Right Cost' with the projected numbers", [afterLookup.bucket, afterLookup.forward?.projectedProfitPerUnit, afterLookup.forward?.maxBuyCost], ["High Demand — Buy Only at the Right Cost", 7, 22.1]);
  check("…but only the forward-looking fields moved: history and score are identical", [afterLookup.profit, afterLookup.avgUnitCost, afterLookup.gmv, afterLookup.score], [beforeLookup.profit, beforeLookup.avgUnitCost, beforeLookup.gmv, beforeLookup.score]);
  check("…and the cost snapshots on the sale records are untouched", (await loadLiveHistory()).sales.filter((x) => x.productId === "pX").map((x) => x.landedCostAtSale), [27, 27, 27, 27, 27, 27]);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
