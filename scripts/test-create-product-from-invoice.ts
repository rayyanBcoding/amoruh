// Regression test: "Create New Product From Invoice" on PO Detail.
// ProductEditorForm posts the product fields at the top level of the request
// body; the route used to read only body.product, so the operator's SKU/name
// were ignored, the (UPC-less) invoice line produced an empty SKU, and the
// operator saw "Please fix the highlighted fields." with nothing highlighted.
// HERMETIC: in-memory fake Redis via globalThis.__amoruhRedis; no production data.
//   npx tsx scripts/test-create-product-from-invoice.ts
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

const PO = "po_test";
const line = (id: string) => ({
  id,
  poId: PO,
  productId: null,
  rawDescription: "PACO RABANNE INVICTUS(M)EDT SP 3.4oz",
  upc: "",
  brand: "Paco Rabanne",
  name: "Invictus",
  size: "3.4oz",
  concentration: "Eau de Toilette",
  expectedQty: 5,
  unitCost: 49,
  lineTotal: 245,
  receivedQty: 0,
  status: "pending",
  matchType: "unmatched",
  matchConfidence: 0.72,
});
const existing = {
  id: "p_existing",
  sku: "EXIST-1",
  barcode: "EXIST-1",
  brand: "Other",
  name: "Existing",
  size: "100ml",
  concentration: "",
  image: "",
  color: "#000",
  cost: 1,
  retailPrice: 0,
  marketPrice: 0,
  lootPrice: 0,
  minPrice: 0,
  topNotes: [],
  middleNotes: [],
  baseNotes: [],
  projection: "",
  longevity: "",
  description: "",
  condition: "New",
  shelf: "",
  inventory: 3,
  authentic: true,
  tiktokListing: "",
  status: "active",
};

async function main() {
  const { KEYS } = await import("../src/lib/intake-db");
  const { KEYS: CoreKeys } = await import("../src/lib/kv");
  const { POST } = await import("../src/app/api/intake/pos/[id]/lines/[lineId]/create-product/route");

  const reset = async () => {
    fake.store.clear();
    await fake.set(CoreKeys.products, [existing]);
    await fake.set(KEYS.pos, [
      {
        id: PO,
        poNumber: "T1",
        supplierId: "sup_t",
        supplierName: "Test",
        invoiceDate: "2026-10-12",
        expectedArrivalDate: null,
        currency: "USD",
        status: "awaiting_delivery",
        invoiceDocumentId: "d",
        createdAt: "2026-10-12",
        lineCount: 3,
        totalExpectedQty: 15,
        totalReceivedQty: 0,
        subtotal: 735,
        shippingCost: 0,
      },
    ]);
    await fake.set(KEYS.poLines(PO), [line("pol_a"), line("pol_b"), line("pol_c")]);
    await fake.set(KEYS.suppliers, []);
  };
  const call = async (lineId: string, body: unknown) => {
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: PO, lineId }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const formPayload = (over: object = {}) => ({
    id: "",
    sku: "3349668515660",
    barcode: "3349668515660",
    brand: "Paco Rabanne",
    name: "Invictus",
    size: "3.4oz",
    concentration: "Eau de Toilette",
    cost: 49,
    retailPrice: 0,
    marketPrice: 0,
    lootPrice: 0,
    minPrice: 0,
    inventory: 0,
    status: "draft",
    condition: "New",
    fragranceNotes: [],
    ...over,
  });
  const productsNow = async () => ((await fake.get(CoreKeys.products)) as any[]) ?? [];
  const linesNow = async () => ((await fake.get(KEYS.poLines(PO))) as any[]) ?? [];

  // 1. The payload shape ProductEditorForm really sends (top-level fields)
  await reset();
  let r = await call("pol_a", formPayload());
  check("form payload (top level) -> 200", r.status, 200);
  check("...creates the product with the operator's SKU", r.json.sku, "3349668515660");
  const ps = await productsNow();
  check("...exactly one new product added", ps.length, 2);
  check("...with the operator's name and zero inventory", [ps[1].name, ps[1].inventory], ["Invictus", 0]);
  const ls = await linesNow();
  check("...the line is linked to it as a new_product", [ls[0].productId, ls[0].matchType], [ps[1].id, "new_product"]);
  check("...other lines are untouched", [ls[1].productId, ls[2].productId], [null, null]);
  check("...no receiving: line received qty still 0", ls[0].receivedQty, 0);

  // 2. The { product } wrapper is still accepted
  await reset();
  r = await call("pol_a", { product: formPayload({ sku: "WRAP-1", barcode: "WRAP-1" }) });
  check("wrapped { product } payload still works", [r.status, r.json.sku], [200, "WRAP-1"]);

  // 3. A genuinely invalid form returns field-level errors (so inputs can be highlighted)
  await reset();
  r = await call("pol_a", formPayload({ sku: "" }));
  check("empty SKU -> 400", r.status, 400);
  check("...with the field named so the form can highlight it", Object.keys(r.json.fields ?? {}), ["sku"]);
  check("...and nothing was created or linked", [(await productsNow()).length, (await linesNow())[0].productId], [1, null]);

  // 4. A SKU that already exists links to that product (existing behaviour, unchanged)
  await reset();
  r = await call("pol_a", formPayload({ sku: "EXIST-1", barcode: "EXIST-1" }));
  check("existing SKU links to the existing product", [r.status, r.json.id], [200, "p_existing"]);
  check("...no duplicate product created", (await productsNow()).length, 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
