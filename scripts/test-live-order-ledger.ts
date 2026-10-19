// Live Order Ledger — acceptance, concurrency and idempotency tests.
//
// HERMETIC: the app's Redis is an in-memory FakeRedis whose EVAL runs the app's
// REAL Lua scripts (see scripts/support/fake-redis.ts), injected through the
// globalThis.__amoruhRedis hook src/lib/kv.ts already honors. These tests call
// the REAL sales-analytics / live-db code; no production data or credentials
// are touched.
//   npx tsx scripts/test-live-order-ledger.ts
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

const product = (id: string, name: string, inventory: number) => ({
  id, sku: `SKU-${id}`, barcode: `BC-${id}`, brand: "Brand", name, size: "100ml", concentration: "EDP", image: "", color: "#000",
  cost: 10, retailPrice: 0, marketPrice: 0, lootPrice: 0, minPrice: 0, topNotes: [], middleNotes: [], baseNotes: [],
  projection: "", longevity: "", description: "", condition: "New", shelf: "", inventory, authentic: true, tiktokListing: "", status: "active",
});

async function main() {
  const { KEYS: Core } = await import("../src/lib/kv");
  const { KEYS: Intake } = await import("../src/lib/intake-db");
  const sales = await import("../src/lib/sales-analytics");
  const live = await import("../src/lib/live-db");
  const { redis } = await import("../src/lib/kv");

  const uid = (() => { let n = 0; return (p: string) => `${p}_${++n}`; })();
  const op = "Tester";

  // ----- fixture: pA (lot @30), pB (lot @40), pC (no lot data, legacy), pD (lot @50, tiny stock) -----
  const lot = (id: string, productId: string, unitCost: number, qty: number) => ({
    id, poId: `po_${productId}`, poNumber: "1", poLineId: `pol_${productId}`, productId, supplierId: "s", supplierName: "S",
    unitCost, receivedQuantity: qty, receivedDate: "2026-10-01T00:00:00.000Z", invoiceDate: "2026-10-01",
  });
  const txnRecv = (lotId: string, productId: string, qty: number) => ({
    id: `txn_recv_${lotId}`, productId, poId: `po_${productId}`, poLineId: `pol_${productId}`, lotId, quantityDelta: qty,
    reason: "receiving", receivingEventId: null, saleId: null, operator: "x", timestamp: "2026-10-01T00:00:00.000Z",
  });
  async function seed() {
    fake.strings.clear(); fake.zsets.clear(); fake.lists.clear();
    await fake.set(Core.products, [product("pA", "Alpha", 10), product("pB", "Bravo", 10), product("pC", "Charlie", 10), product("pD", "Delta", 2)]);
    await fake.set(Intake.lots("pA"), [lot("lotA", "pA", 30, 10)]);
    await fake.set(Intake.lots("pB"), [lot("lotB", "pB", 40, 10)]);
    await fake.set(Intake.lots("pD"), [lot("lotD", "pD", 50, 2)]);
    await fake.set(Intake.inventoryTransactions, [txnRecv("lotA", "pA", 10), txnRecv("lotB", "pB", 10), txnRecv("lotD", "pD", 2)]);
    await fake.set(Intake.pos, [
      { id: "po_pA", shippingCost: 0, totalExpectedQty: 10 }, { id: "po_pB", shippingCost: 0, totalExpectedQty: 10 }, { id: "po_pD", shippingCost: 0, totalExpectedQty: 2 },
    ]);
  }
  /** end the previous Live (if any), reset the fixture, start a new Live */
  let previousLive: string | null = null;
  async function freshLive(name: string, reseed = true): Promise<string> {
    if (previousLive) await live.endLiveSession(previousLive);
    if (reseed) await seed();
    const id = (await live.startLiveSession(name, op)).id;
    previousLive = id;
    return id;
  }
  const inventoryOf = async (id: string) => ((await fake.get<any[]>(Core.products)) ?? []).find((p) => p.id === id).inventory as number;
  const lotRemaining = async (productId: string, lotId: string) =>
    ((await fake.get<any[]>(Intake.inventoryTransactions)) ?? []).filter((t) => t.productId === productId && t.lotId === lotId).reduce((s, t) => s + t.quantityDelta, 0) as number;
  const record = (sessionId: string, productId: string, bid: number, quantity = 1, key = uid("rec")) =>
    sales.recordSale({ liveSessionId: sessionId, productId, quantity, winningBid: bid, operator: op, idempotencyKey: key });
  const ledger = (sessionId: string, q: any = {}) => live.getSessionOrderLedger(sessionId, q);

  // =====================================================================
  section("A. Acceptance: start Live → #1,#2,#3 → search → edit → cancel → #4 → restore → persist → end → history");
  const sid = await freshLive("Acceptance Live");
  const a = await record(sid, "pA", 50);
  const b = await record(sid, "pB", 65);
  const c = await record(sid, "pC", 80);
  check("sale A is LIVE Order #1", a.liveOrderNumber, 1);
  check("sale B is LIVE Order #2", b.liveOrderNumber, 2);
  check("sale C is LIVE Order #3", c.liveOrderNumber, 3);

  let stats = await live.getSessionStats(sid);
  check("entered/active/canceled = 3/3/0", [stats.enteredOrders, stats.activeOrders, stats.canceledOrders], [3, 3, 0]);
  check("GMV = 195", stats.revenue, 195);

  let page = await ledger(sid, { q: "#2" });
  check("search '#2' puts Order #2 first", page.rows[0].sale.liveOrderNumber, 2);
  check("'#2' matches only order numbers (no barcode/SKU noise)", (await ledger(sid, { q: "#2" })).rows.map((r) => r.sale.liveOrderNumber), [2]);
  page = await ledger(sid, { q: "2", status: "all" });
  check("search '2' → exact #2 first", page.rows[0].sale.liveOrderNumber, 2);
  check("default list is newest first (#3,#2,#1)", (await ledger(sid)).rows.map((r) => r.sale.liveOrderNumber), [3, 2, 1]);
  check("search by SKU finds the order", (await ledger(sid, { q: "SKU-pC" })).rows.map((r) => r.sale.liveOrderNumber), [3]);
  check("search by barcode finds the order", (await ledger(sid, { q: "BC-pA" })).rows.map((r) => r.sale.liveOrderNumber), [1]);
  check("search by product name finds the order", (await ledger(sid, { q: "bravo" })).rows.map((r) => r.sale.liveOrderNumber), [2]);

  const rowB0 = (await ledger(sid, { q: "#2" })).rows[0];
  check("#2 profit before edit = 65 - 40 = 25", rowB0.financials.profit, 25);
  const edited = await sales.editSale({ saleId: b.saleId, newPrice: 70, operator: op, idempotencyKey: uid("edit") });
  check("edit changed the price", edited.price, 70);
  check("edit kept order number #2", edited.liveOrderNumber, 2);
  const rowB1 = (await ledger(sid, { q: "#2" })).rows[0];
  check("#2 profit after edit = 70 - 40 = 30", rowB1.financials.profit, 30);
  check("#2 margin after edit = 30/70", rowB1.financials.margin, 30 / 70);
  stats = await live.getSessionStats(sid);
  check("GMV after edit = 200", stats.revenue, 200);
  const audB = await sales.getSaleAudit(b.saleId);
  check("audit: created then price_changed", audB.map((e) => e.action), ["created", "price_changed"]);
  check("audit shows $65 → $70", [audB[1].before, audB[1].after], [{ price: 65 }, { price: 70 }]);
  ok("audit event carries timestamp + operator", Boolean(audB[1].at) && audB[1].operator === op);

  check("pA inventory before cancel", await inventoryOf("pA"), 9);
  const canceledA = await sales.cancelSale({ saleId: a.saleId, operator: op, idempotencyKey: uid("cancel") });
  check("#1 canceled", canceledA.status, "canceled");
  check("#1 keeps number 1 and its price/qty/cost", [canceledA.liveOrderNumber, canceledA.price, canceledA.quantity, canceledA.landedCostAtSale], [1, 50, 1, 30]);
  const listAfterCancel = await ledger(sid);
  check("#1 stays visible, as canceled", listAfterCancel.rows.find((r) => r.sale.liveOrderNumber === 1)?.status, "canceled");
  check("inventory restored exactly once", await inventoryOf("pA"), 10);
  check("lot stock restored exactly once", await lotRemaining("pA", "lotA"), 10);
  stats = await live.getSessionStats(sid);
  check("canceled order adds nothing to active GMV", stats.revenue, 150);
  check("canceled order adds nothing to cost/profit", [stats.costOfGoods, stats.estimatedGrossProfit], [stats.costOfGoods, null]);
  check("units exclude the canceled order", stats.unitsSold, 2);
  check("entered 3 / active 2 / canceled 1", [stats.enteredOrders, stats.activeOrders, stats.canceledOrders], [3, 2, 1]);
  check("canceled filter lists only #1", (await ledger(sid, { status: "canceled" })).rows.map((r) => r.sale.liveOrderNumber), [1]);
  check("active filter lists #3,#2", (await ledger(sid, { status: "active" })).rows.map((r) => r.sale.liveOrderNumber), [3, 2]);

  const d = await record(sid, "pB", 90);
  check("next sale after a cancel is #4 (number #1 never reused)", d.liveOrderNumber, 4);

  const restored = await sales.restoreSale({ saleId: a.saleId, operator: op, idempotencyKey: uid("restore") });
  check("restore reactivates #1", [restored.status, restored.liveOrderNumber], ["completed", 1]);
  check("restore keeps original cost/price", [restored.landedCostAtSale, restored.price], [30, 50]);
  check("restore decrements inventory again", await inventoryOf("pA"), 9);
  check("restore decrements the lot again", await lotRemaining("pA", "lotA"), 9);
  const audA = await sales.getSaleAudit(a.saleId);
  check("audit for #1: created, canceled, restored", audA.map((e) => e.action), ["created", "canceled", "restored"]);
  stats = await live.getSessionStats(sid);
  check("#1 is back in the totals: 4 entered/4 active/0 canceled", [stats.enteredOrders, stats.activeOrders, stats.canceledOrders], [4, 4, 0]);
  check("GMV after restore = 50+70+80+90", stats.revenue, 290);

  // "refresh browser": nothing lives in memory — a fresh read of the ledger/detail returns the same facts
  const refreshed = await ledger(sid);
  check("after refresh: all four orders and statuses persist", refreshed.rows.map((r) => [r.sale.liveOrderNumber, r.status]), [[4, "active"], [3, "active"], [2, "active"], [1, "active"]]);
  const detailA = await live.getOrderDetail(a.saleId);
  check("after refresh: audit events persist", detailA?.audit.map((e) => e.action), ["created", "canceled", "restored"]);
  check("detail is editable while the Live is active", detailA?.editable, true);

  await live.endLiveSession(sid);
  previousLive = null;
  const ended = await ledger(sid);
  check("ended Live: complete ledger still available", ended.counts, { entered: 4, active: 4, canceled: 0 });
  const endedStats = await live.getSessionStats(sid);
  check("ended Live: totals intact", [endedStats.revenue, endedStats.activeOrders], [290, 4]);
  check("ended Live detail is read-only", (await live.getOrderDetail(a.saleId))?.editable, false);
  for (const [label, fn] of [
    ["edit", () => sales.editSale({ saleId: a.saleId, newPrice: 1, operator: op, idempotencyKey: uid("e") })],
    ["cancel", () => sales.cancelSale({ saleId: a.saleId, operator: op, idempotencyKey: uid("c") })],
  ] as const) {
    let msg = "";
    try { await fn(); } catch (e) { msg = (e as Error).message; }
    check(`ended Live: ${label} is refused`, /read-only/.test(msg), true);
  }
  check("ended Live: nothing changed by the refused attempts", [await inventoryOf("pA"), (await sales.getSaleRecordById(a.saleId))?.status], [9, "completed"]);

  // =====================================================================
  section("B. Concurrency: simultaneous RECORD SALE requests never share an order number");
  const s2 = await freshLive("Concurrency Live");
  // 8 products worth of stock so 24 concurrent sales never run out; spread across 3 products
  await fake.set(Core.products, [product("pA", "Alpha", 100), product("pB", "Bravo", 100), product("pC", "Charlie", 100), product("pD", "Delta", 2)]);
  await fake.set(Intake.lots("pA"), [lot("lotA", "pA", 30, 100)]);
  await fake.set(Intake.lots("pB"), [lot("lotB", "pB", 40, 100)]);
  await fake.set(Intake.inventoryTransactions, [txnRecv("lotA", "pA", 100), txnRecv("lotB", "pB", 100), txnRecv("lotD", "pD", 2)]);

  const N = 24;
  const settled = await Promise.allSettled(Array.from({ length: N }, (_, i) => record(s2, ["pA", "pB", "pC"][i % 3], 10 + i)));
  const fulfilled = settled.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled").map((r) => r.value.liveOrderNumber as number);
  const rejected = settled.filter((r) => r.status === "rejected");
  console.log(`   ${fulfilled.length} succeeded, ${rejected.length} rejected (version-conflict exhaustion) of ${N}`);
  check("no duplicate LIVE Order numbers among simultaneous sales", new Set(fulfilled).size, fulfilled.length);
  ok("at least some simultaneous sales succeeded", fulfilled.length > 0);
  const sorted = [...fulfilled].sort((x, y) => x - y);
  check("numbers are contiguous 1..n (a rejected attempt never burns a number)", sorted, Array.from({ length: fulfilled.length }, (_, i) => i + 1));
  const seq = await fake.get<number>(`amoruh:live:session_order_seq:${s2}`);
  check("sequence key equals the number of recorded orders", seq, fulfilled.length);
  const led2 = await ledger(s2, { limit: 200 });
  check("ledger lists exactly the successful orders", led2.total, fulfilled.length);
  check("every stored sale has a distinct number", new Set(led2.rows.map((r) => r.sale.liveOrderNumber)).size, fulfilled.length);

  // sales on DISTINCT products never conflict on a product version, so all must succeed
  const s3 = await freshLive("Distinct Live", false);
  const many = [...Array.from({ length: 30 }, (_, i) => `pX${i}`)];
  await fake.set(Core.products, many.map((id) => product(id, id, 5)));
  const settled2 = await Promise.allSettled(many.map((id, i) => record(s3, id, 5 + i)));
  check("30 simultaneous sales on distinct products all succeed", settled2.every((r) => r.status === "fulfilled"), true);
  const nums2 = settled2.map((r) => (r as PromiseFulfilledResult<any>).value.liveOrderNumber as number).sort((x, y) => x - y);
  check("…with order numbers exactly 1..30", nums2, Array.from({ length: 30 }, (_, i) => i + 1));

  // a failed sale (out of stock) must not consume a number
  const s4 = await freshLive("Failure Live");
  const f1 = await record(s4, "pD", 10);
  check("first sale #1", f1.liveOrderNumber, 1);
  let failedMsg = "";
  try { await record(s4, "pD", 10, 5); } catch (e) { failedMsg = (e as Error).message; }
  ok("selling more than the stock is refused", /Not enough stock/.test(failedMsg));
  const f2 = await record(s4, "pD", 10);
  check("a failed sale did not consume a number: next is #2", f2.liveOrderNumber, 2);

  // =====================================================================
  section("C. Idempotency & retries");
  const s5 = await freshLive("Idempotency Live");
  const k = "same-key";
  const [r1, r2, r3] = await Promise.all([record(s5, "pA", 40, 1, k), record(s5, "pA", 40, 1, k), record(s5, "pA", 40, 1, k)]);
  check("3 concurrent RECORD SALE retries with one key → one sale", new Set([r1.saleId, r2.saleId, r3.saleId]).size, 1);
  check("…with one order number", new Set([r1.liveOrderNumber, r2.liveOrderNumber, r3.liveOrderNumber]).size, 1);
  check("…and one number consumed", await fake.get(`amoruh:live:session_order_seq:${s5}`), 1);
  check("…and inventory decremented once", await inventoryOf("pA"), 9);
  const later = await record(s5, "pA", 41, 1, k); // sequential replay long after
  check("a later replay of the same key returns the SAME order", [later.saleId, later.liveOrderNumber], [r1.saleId, 1]);

  const ek = "edit-key";
  await Promise.all([1, 2, 3].map(() => sales.editSale({ saleId: r1.saleId, newPrice: 55, operator: op, idempotencyKey: ek })));
  const auditAfterEdits = await sales.getSaleAudit(r1.saleId);
  check("edit retried 3x with one key → one audit event", auditAfterEdits.filter((e) => e.action === "price_changed").length, 1);
  check("edit applied once", (await sales.getSaleRecordById(r1.saleId))?.price, 55);

  const ck = "cancel-key";
  await Promise.all([1, 2, 3].map(() => sales.cancelSale({ saleId: r1.saleId, operator: op, idempotencyKey: ck })));
  check("cancel retried 3x with one key → inventory restored once", await inventoryOf("pA"), 10);
  await sales.cancelSale({ saleId: r1.saleId, operator: op, idempotencyKey: "another-cancel-key" });
  check("cancel again with a NEW key is a no-op (not restored twice)", [await inventoryOf("pA"), await lotRemaining("pA", "lotA")], [10, 10]);
  check("…and adds no second canceled audit event", (await sales.getSaleAudit(r1.saleId)).filter((e) => e.action === "canceled").length, 1);

  const rk = "restore-key";
  await Promise.all([1, 2, 3].map(() => sales.restoreSale({ saleId: r1.saleId, operator: op, idempotencyKey: rk })));
  check("restore retried 3x with one key → decremented once", [await inventoryOf("pA"), await lotRemaining("pA", "lotA")], [9, 9]);
  await Promise.all([1, 2].map((i) => sales.restoreSale({ saleId: r1.saleId, operator: op, idempotencyKey: `restore-other-${i}` })));
  check("restore again with NEW keys is a no-op (already active)", [await inventoryOf("pA"), (await sales.getSaleAudit(r1.saleId)).filter((e) => e.action === "restored").length], [9, 1]);

  // two DIFFERENT cancel requests racing on one order restore stock once
  const rc = await record(s5, "pB", 70);
  await Promise.allSettled([sales.cancelSale({ saleId: rc.saleId, operator: op, idempotencyKey: "rc1" }), sales.cancelSale({ saleId: rc.saleId, operator: op, idempotencyKey: "rc2" })]);
  check("two racing cancels with different keys → stock restored once", await inventoryOf("pB"), 10);
  // two DIFFERENT restore requests racing: decremented once
  await Promise.allSettled([sales.restoreSale({ saleId: rc.saleId, operator: op, idempotencyKey: "rs1" }), sales.restoreSale({ saleId: rc.saleId, operator: op, idempotencyKey: "rs2" })]);
  check("two racing restores with different keys → decremented once", [await inventoryOf("pB"), await lotRemaining("pB", "lotB")], [9, 9]);
  check("full audit trail for the raced order", (await sales.getSaleAudit(rc.saleId)).map((e) => e.action), ["created", "canceled", "restored"]);

  // =====================================================================
  section("D. Edits: quantity and product");
  const s6 = await freshLive("Edit Live");
  const q = await record(s6, "pA", 100, 2); // 2 units @30 → cost 30/unit
  check("qty-2 sale consumed 2 units", [await inventoryOf("pA"), await lotRemaining("pA", "lotA")], [8, 8]);
  const q3 = await sales.editSale({ saleId: q.saleId, newQuantity: 5, operator: op, idempotencyKey: uid("q") });
  check("quantity 2→5 reconciles only the difference (3 more units)", [await inventoryOf("pA"), await lotRemaining("pA", "lotA")], [5, 5]);
  check("…keeps the frozen unit cost", q3.landedCostAtSale, 30);
  check("…presentation quantity follows", (await redis.get<any>(`amoruh:live:presentation:${q3.presentationId}`)).quantity, 5);
  check("…aggregate units follow", (await redis.get<any>("amoruh:sales:aggregate:pA")).completedUnitsSold, 5);
  const q1 = await sales.editSale({ saleId: q.saleId, newQuantity: 1, operator: op, idempotencyKey: uid("q") });
  check("quantity 5→1 returns 4 units", [await inventoryOf("pA"), await lotRemaining("pA", "lotA")], [9, 9]);
  check("quantity audit: before/after recorded", (await sales.getSaleAudit(q.saleId)).filter((e) => e.action === "quantity_changed").map((e) => [e.before, e.after]), [[{ quantity: 2 }, { quantity: 5 }], [{ quantity: 5 }, { quantity: 1 }]]);
  check("quantity edit keeps the order number", q1.liveOrderNumber, 1);
  let tooMany = "";
  try { await sales.editSale({ saleId: q.saleId, newQuantity: 999, operator: op, idempotencyKey: uid("q") }); } catch (e) { tooMany = (e as Error).message; }
  ok("raising quantity beyond stock is refused", /Not enough stock/.test(tooMany));
  check("…and changed nothing", [await inventoryOf("pA"), (await sales.getSaleRecordById(q.saleId))?.quantity], [9, 1]);

  // product change A → B (B has a different cost)
  const pc = await sales.editSale({ saleId: q.saleId, newProductId: "pB", operator: op, idempotencyKey: uid("pc") });
  check("product change restores the original product", await inventoryOf("pA"), 10);
  check("…and decrements the replacement", await inventoryOf("pB"), 9);
  check("…lot stock moved with it", [await lotRemaining("pA", "lotA"), await lotRemaining("pB", "lotB")], [10, 9]);
  check("…snapshots the replacement's cost (40)", pc.landedCostAtSale, 40);
  check("…sale and presentation point at the new product", [pc.productId, (await redis.get<any>(`amoruh:live:presentation:${pc.presentationId}`)).productId], ["pB", "pB"]);
  check("…aggregates moved between products", [(await redis.get<any>("amoruh:sales:aggregate:pA"))?.completedSaleCount, (await redis.get<any>("amoruh:sales:aggregate:pB"))?.completedSaleCount], [0, 1]);
  check("…by-product index moved", [await fake.zscore("amoruh:sales:by_product:pA", q.saleId), (await fake.zscore("amoruh:sales:by_product:pB", q.saleId)) !== null], [null, true]);
  const pAudit = (await sales.getSaleAudit(q.saleId)).find((e) => e.action === "product_changed");
  check("product audit keeps the old product + old cost", [pAudit?.before, pAudit?.after], [
    { productId: "pA", sku: "SKU-pA", name: "Brand Alpha", landedCostAtSale: 30 },
    { productId: "pB", sku: "SKU-pB", name: "Brand Bravo", landedCostAtSale: 40 },
  ]);
  // switching to a product with no lot data → no cost basis, stock still moves
  const toC = await sales.editSale({ saleId: q.saleId, newProductId: "pC", operator: op, idempotencyKey: uid("pc") });
  check("switch to a no-lot product: cost null, inventory moves", [toC.landedCostAtSale, await inventoryOf("pB"), await inventoryOf("pC")], [null, 10, 9]);
  // cancel after edits reverses only what the sale currently holds
  await sales.cancelSale({ saleId: q.saleId, operator: op, idempotencyKey: uid("cx") });
  check("cancel after edits leaves every product at its original stock", [await inventoryOf("pA"), await inventoryOf("pB"), await inventoryOf("pC")], [10, 10, 10]);
  check("…and lots are whole again", [await lotRemaining("pA", "lotA"), await lotRemaining("pB", "lotB")], [10, 10]);
  // restore with insufficient stock is refused
  await fake.set(Core.products, ((await fake.get<any[]>(Core.products)) as any[]).map((p) => (p.id === "pC" ? { ...p, inventory: 0 } : p)));
  let restoreMsg = "";
  try { await sales.restoreSale({ saleId: q.saleId, operator: op, idempotencyKey: uid("rs") }); } catch (e) { restoreMsg = (e as Error).message; }
  ok("restore without enough stock is refused", /Not enough stock to restore/.test(restoreMsg));
  check("…and the order stays canceled", (await sales.getSaleRecordById(q.saleId))?.status, "canceled");

  // =====================================================================
  section("E. Backward compatibility");
  const s7 = await freshLive("Legacy Live");
  // a sale written BEFORE the ledger existed: no liveOrderNumber, no audit list
  const legacy = { id: "sale_legacy", productId: "pA", sku: "SKU-pA", price: 33, quantity: 1, soldAt: "2026-10-01T10:00:00.000Z", status: "completed", lotId: null, landedCostAtSale: null, liveSessionId: s7, presentationId: "pres_legacy", saleVersion: 0, originalPrice: null, correctedAt: null, correctedBy: null, canceledAt: null, canceledBy: null };
  await fake.set("amoruh:sales:sale_legacy", legacy);
  await fake.set("amoruh:live:presentation:pres_legacy", { id: "pres_legacy", liveSessionId: s7, productId: "pA", sku: "SKU-pA", outcome: "sold", quantity: 1, saleId: "sale_legacy", timestamp: "2026-10-01T10:00:00.000Z", operator: "x" });
  await fake.zadd(`amoruh:live:presentations_by_session:${s7}`, { score: 1, member: "pres_legacy" });
  const lg = await ledger(s7);
  check("a legacy sale is listed without an invented number", [lg.rows.length, lg.rows[0].sale.liveOrderNumber], [1, null]);
  check("reading never writes a number", (await fake.get<any>("amoruh:sales:sale_legacy")).liveOrderNumber, undefined);
  const newer = await record(s7, "pB", 20);
  check("a new sale after the ledger shipped always gets a number", newer.liveOrderNumber, 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
