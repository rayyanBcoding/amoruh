// Intake: change / switch / clear a PO line's product match BEFORE final receipt.
//   - choose a different existing product
//   - switch to Create New Product (replace mode)
//   - switch from a new product back to an existing one
//   - clear the match
// Only while the intake is pending; nothing here ever changes inventory.
// HERMETIC: in-memory fake Redis via globalThis.__amoruhRedis; no production data.
//   npx tsx scripts/test-intake-change-match.ts
export {}; // make this file a module so its top-level names don't clash with other test scripts
let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.log(`FAIL: ${label}\n   expected ${JSON.stringify(expected)}\n   got      ${JSON.stringify(actual)}`);
  }
}

class Fake {
  store = new Map<string, string>();
  async get(k: string) {
    const v = this.store.get(k);
    return v === undefined ? null : JSON.parse(v);
  }
  async set(k: string, v: unknown) {
    this.store.set(k, JSON.stringify(v));
    return "OK";
  }
  async del(k: string) {
    this.store.delete(k);
    return 1;
  }
  async incr(k: string) {
    const n = Number(this.store.get(k) ?? 0) + 1;
    this.store.set(k, String(n));
    return n;
  }
}
const fake = new Fake();
(globalThis as unknown as { __amoruhRedis: unknown }).__amoruhRedis = new Proxy(fake, {
  get(t, p, r) {
    if (p === "then") return undefined;
    if (p in t) return Reflect.get(t, p, r);
    return () => {
      throw new Error(`unexpected redis.${String(p)}()`);
    };
  },
});

const PO = "po_chg";
const baseProduct = (id: string, sku: string, inventory: number) => ({
  id, sku, barcode: sku, brand: "Brand", name: `Name ${sku}`, size: "100ml", concentration: "", image: "", color: "#000",
  cost: 10, retailPrice: 0, marketPrice: 0, lootPrice: 0, minPrice: 0, topNotes: [], middleNotes: [], baseNotes: [],
  projection: "", longevity: "", description: "", condition: "New", shelf: "", inventory, authentic: true, tiktokListing: "", status: "active",
});
const line = (id: string, over: Record<string, unknown> = {}) => ({
  id, poId: PO, productId: null, rawDescription: "PACO RABANNE INVICTUS(M)EDT SP 3.4oz", upc: "", brand: "Paco Rabanne", name: "Invictus",
  size: "3.4oz", concentration: "Eau de Toilette", expectedQty: 5, unitCost: 49, lineTotal: 245, receivedQty: 0, status: "pending",
  matchType: "unmatched", matchConfidence: 0.72, ...over,
});
type Line = { id: string; productId: string | null; matchType: string; receivedQty: number };
type Prod = { id: string; sku: string; inventory: number };

async function main() {
  const { KEYS } = await import("../src/lib/intake-db");
  const { KEYS: CoreKeys } = await import("../src/lib/kv");
  const { lineMatchEditBlock } = await import("../src/lib/intake-line-edit");
  const { PATCH } = await import("../src/app/api/intake/pos/[id]/route");
  const { POST } = await import("../src/app/api/intake/pos/[id]/lines/[lineId]/create-product/route");

  const reset = async (poStatus = "awaiting_delivery", lines: ReturnType<typeof line>[] = [line("pol_a")]) => {
    fake.store.clear();
    await fake.set(CoreKeys.products, [baseProduct("p_one", "ONE-1", 3), baseProduct("p_two", "TWO-2", 7)]);
    await fake.set(KEYS.pos, [
      { id: PO, poNumber: "T", supplierId: "sup", supplierName: "S", invoiceDate: "2026-11-01", expectedArrivalDate: null, currency: "USD", status: poStatus,
        invoiceDocumentId: "d", createdAt: "2026-11-01", lineCount: lines.length, totalExpectedQty: 5 * lines.length, totalReceivedQty: 0, subtotal: 245, shippingCost: 0 },
    ]);
    await fake.set(KEYS.poLines(PO), lines);
    await fake.set(KEYS.suppliers, []);
  };
  const patch = async (body: unknown) => {
    const res = await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: PO }) });
    return { status: res.status, json: (await res.json()) as { error?: string; code?: string } };
  };
  const create = async (lineId: string, replace: boolean, over: object = {}) => {
    const res = await POST(
      new Request(`http://x/create${replace ? "?replace=1" : ""}`, {
        method: "POST",
        body: JSON.stringify({ sku: "NEW-100", barcode: "NEW-100", brand: "Paco Rabanne", name: "Invictus", size: "3.4oz", concentration: "Eau de Toilette", cost: 49, inventory: 0, status: "draft", condition: "New", fragranceNotes: [], ...over }),
      }),
      { params: Promise.resolve({ id: PO, lineId }) }
    );
    return { status: res.status, json: (await res.json()) as { id?: string; sku?: string; error?: string } };
  };
  const lines = async () => ((await fake.get(KEYS.poLines(PO))) as Line[]) ?? [];
  const prods = async () => ((await fake.get(CoreKeys.products)) as Prod[]) ?? [];
  const invOf = async (id: string) => (await prods()).find((p) => p.id === id)?.inventory;

  // ---------- the shared rule ----------
  const ids = new Set(["p_one"]);
  check("unlinked line is never blocked", lineMatchEditBlock({ status: "awaiting_delivery" }, { productId: null, receivedQty: 0 }, ids), null);
  check("linked + pending is editable", lineMatchEditBlock({ status: "awaiting_delivery" }, { productId: "p_one", receivedQty: 0 }, ids), null);
  check("partially received PO: an untouched line is still editable", lineMatchEditBlock({ status: "partially_received" }, { productId: "p_one", receivedQty: 0 }, ids), null);
  check("stock received against the line → locked", lineMatchEditBlock({ status: "partially_received" }, { productId: "p_one", receivedQty: 2 }, ids)?.code, "ALREADY_RECEIVED");
  for (const st of ["received", "closed", "canceled"] as const) check(`PO ${st} → locked`, lineMatchEditBlock({ status: st }, { productId: "p_one", receivedQty: 0 }, ids)?.code, "PO_LOCKED");
  check("stale link (product deleted) is repairable even if received", lineMatchEditBlock({ status: "partially_received" }, { productId: "p_gone", receivedQty: 4 }, ids), null);

  // ---------- change / clear an existing match (PATCH) ----------
  await reset();
  let r = await patch({ lineId: "pol_a", productId: "p_one" });
  check("link to an existing product", [r.status, (await lines())[0].productId, (await lines())[0].matchType], [200, "p_one", "manual"]);
  r = await patch({ lineId: "pol_a", productId: "p_two" });
  check("choose a different existing product", [r.status, (await lines())[0].productId, (await lines())[0].matchType], [200, "p_two", "manual"]);
  r = await patch({ lineId: "pol_a", productId: "p_two" });
  check("re-selecting the same product is a harmless no-op", [r.status, (await lines())[0].productId], [200, "p_two"]);
  r = await patch({ lineId: "pol_a", productId: null });
  check("clear the match", [r.status, (await lines())[0].productId, (await lines())[0].matchType], [200, null, "unmatched"]);
  check("none of that changed inventory or received quantity", [await invOf("p_one"), await invOf("p_two"), (await lines())[0].receivedQty], [3, 7, 0]);

  // ---------- blocked once receiving has happened / PO is no longer pending ----------
  await reset("partially_received", [line("pol_a", { productId: "p_one", matchType: "manual", receivedQty: 2, status: "partial" })]);
  r = await patch({ lineId: "pol_a", productId: "p_two" });
  check("changing a received line is refused (409 ALREADY_RECEIVED)", [r.status, r.json.code], [409, "ALREADY_RECEIVED"]);
  r = await patch({ lineId: "pol_a", productId: null });
  check("clearing a received line is refused too", [r.status, r.json.code], [409, "ALREADY_RECEIVED"]);
  check("…and the line is untouched", [(await lines())[0].productId, (await lines())[0].receivedQty], ["p_one", 2]);
  for (const st of ["closed", "canceled", "received"]) {
    await reset(st, [line("pol_a", { productId: "p_one", matchType: "manual" })]);
    r = await patch({ lineId: "pol_a", productId: "p_two" });
    check(`PO ${st}: change refused (409 PO_LOCKED)`, [r.status, r.json.code, (await lines())[0].productId], [409, "PO_LOCKED", "p_one"]);
  }
  await reset("partially_received", [line("pol_a", { productId: "p_gone", matchType: "manual", receivedQty: 3, status: "partial" })]);
  r = await patch({ lineId: "pol_a", productId: "p_two" });
  check("a stale match (deleted product) can still be repaired", [r.status, (await lines())[0].productId], [200, "p_two"]);
  await reset("partially_received", [line("pol_a", { productId: "p_one", matchType: "manual", receivedQty: 2 }), line("pol_b", { productId: "p_one", matchType: "manual" })]);
  r = await patch({ lineId: "pol_b", productId: "p_two" });
  check("in a partially received PO, a line with nothing received can still be changed", [r.status, (await lines())[1].productId], [200, "p_two"]);

  // ---------- switch to Create New Product (replace mode) ----------
  await reset("awaiting_delivery", [line("pol_a", { productId: "p_one", matchType: "manual" })]);
  let c = await create("pol_a", false);
  check("without replace, an already-linked line is left alone (existing behavior)", [c.status, c.json.id, (await prods()).length, (await lines())[0].productId], [200, "p_one", 2, "p_one"]);
  c = await create("pol_a", true);
  const newId = c.json.id as string;
  check("replace mode creates a NEW product and re-links the line", [c.status, (await prods()).length, (await lines())[0].productId, (await lines())[0].matchType], [200, 3, newId, "new_product"]);
  check("the new product starts with 0 inventory; the old product is untouched", [await invOf(newId), await invOf("p_one")], [0, 3]);

  // ---------- switch from New Product back to Existing ----------
  r = await patch({ lineId: "pol_a", productId: "p_two" });
  check("switch back to an existing product", [r.status, (await lines())[0].productId, (await lines())[0].matchType], [200, "p_two", "manual"]);
  check("the product created earlier stays in the catalog as a 0-stock draft (nothing deleted)", [(await prods()).length, await invOf(newId)], [3, 0]);
  c = await create("pol_a", true);
  check("creating again with the same SKU re-links the earlier product instead of duplicating it", [c.status, c.json.id, (await prods()).length], [200, newId, 3]);

  // ---------- replace mode is blocked after receiving / when not pending ----------
  await reset("partially_received", [line("pol_a", { productId: "p_one", matchType: "manual", receivedQty: 2, status: "partial" })]);
  c = await create("pol_a", true);
  check("replace on a received line is refused; no product created; line unchanged", [c.status, (await prods()).length, (await lines())[0].productId], [400, 2, "p_one"]);
  await reset("closed", [line("pol_a", { productId: "p_one", matchType: "manual" })]);
  c = await create("pol_a", true);
  check("replace on a closed PO is refused", [c.status, (await prods()).length, (await lines())[0].productId], [400, 2, "p_one"]);

  // ---------- an unlinked line still works exactly as before ----------
  await reset();
  c = await create("pol_a", false);
  check("normal Create New Product on an unlinked line (no replace needed)", [c.status, (await lines())[0].matchType, (await prods()).length], [200, "new_product", 3]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(1);
});
