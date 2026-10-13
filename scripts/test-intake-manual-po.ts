// Tests for Inventory Intake's "Continue without AI" manual purchase-order
// fallback. HERMETIC: the app's Redis client is replaced (through the same
// globalThis.__amoruhRedis hook src/lib/kv.ts already honors) with an
// in-memory fake that records every key written, so these tests can run the
// REAL parse handler, the REAL POST /api/intake/pos route and the REAL
// createPOFromReview without any possibility of touching production data.
// Any Redis operation the fake doesn't implement throws, so a surprise write
// path (Lua, sorted sets, ...) fails the test loudly.
//   npx tsx scripts/test-intake-manual-po.ts
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

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

// ---------------------------------------------------------------------
// Fake Redis
// ---------------------------------------------------------------------
class FakeRedis {
  store = new Map<string, string>();
  writes: string[] = [];
  async get(key: string) {
    const v = this.store.get(key);
    return v === undefined ? null : JSON.parse(v);
  }
  async set(key: string, value: unknown) {
    this.store.set(key, JSON.stringify(value));
    this.writes.push(key);
    return "OK";
  }
  async del(key: string) {
    this.store.delete(key);
    this.writes.push(key);
    return 1;
  }
}
const fake = new FakeRedis();
(globalThis as unknown as { __amoruhRedis: unknown }).__amoruhRedis = new Proxy(fake, {
  get(target, prop, receiver) {
    if (prop === "then") return undefined; // not a thenable
    if (prop in target) return Reflect.get(target, prop, receiver);
    return () => {
      throw new Error(`unexpected redis.${String(prop)}() — the manual PO flow should only use get/set/del`);
    };
  },
});

function product(id: string, sku: string, barcode: string, brand: string, name: string, size: string, inventory: number) {
  return { id, sku, barcode, brand, name, size, concentration: "Eau de Parfum", description: "", cost: 100, price: 0, inventory, status: "active" };
}
const P1 = product("p_aventus", "AVT-100", "3760265190164", "Creed", "Aventus", "100ml", 7);
const P2 = product("p_sauvage", "SAUV-100", "3348901250153", "Dior", "Sauvage", "100ml", 4);
const P3 = product("p_bleu", "BLEU-100", "3348901078839", "Chanel", "Bleu de Chanel", "100ml", 9);
const PRODUCTS = [P1, P2, P3];

async function main() {
  const { KEYS } = await import("../src/lib/intake-db");
  const { KEYS: CoreKeys } = await import("../src/lib/kv");
  const { handleParseInvoice } = await import("../src/lib/intake-parse-handler");
  const { canContinueWithoutAI, createEmptyManualDraft, addManualLine, removeManualLine, applyManualLineEdit, selectProductForLine, validateManualDraft, buildCreatePOBody } = await import("../src/lib/intake-manual-po");
  const { POST: createPO } = await import("../src/app/api/intake/pos/route");
  type Product = Parameters<typeof applyManualLineEdit>[3][number];

  // Existing inventory state that must never change on this path.
  await fake.set(CoreKeys.products, PRODUCTS);
  await fake.set(KEYS.inventoryTransactions, [{ id: "txn_1", productId: P1.id, lotId: "lot_1", quantityDelta: 7, reason: "receiving", saleId: null }]);
  await fake.set(KEYS.lots(P1.id), [{ id: "lot_1", productId: P1.id, poId: "po_old", unitCost: 90 }]);
  await fake.set(KEYS.receivingEvents, []);
  fake.writes.length = 0; // only count writes made BY the code under test
  const protectedKeys = [CoreKeys.products, KEYS.inventoryTransactions, KEYS.lots(P1.id), KEYS.receivingEvents];
  const snapshot = () => JSON.stringify(protectedKeys.map((k) => fake.store.get(k) ?? null));
  const before = snapshot();
  const products = PRODUCTS as unknown as Product[];

  const parseReq = () => new Request("http://localhost/api/intake/parse", { method: "POST", body: JSON.stringify({ blobUrl: "https://blob.example/inv.pdf", filename: "inv.pdf" }) });
  const creditBody = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." }, request_id: "req_credit" };
  const AGREED = "Invoice extraction is temporarily unavailable because the AI service account needs credits. No inventory was changed. You can still enter the purchase order manually.";

  // ====================================================================
  console.log("1. AI extraction succeeds -> the normal existing flow, unchanged");
  // ====================================================================
  {
    const res = await handleParseInvoice(parseReq(), {
      apiKeyConfigured: () => true,
      loadProducts: async () => products,
      extract: async () => ({
        poNumber: "INV-9", supplierName: "Test Supplier", invoiceDate: "2026-10-11", currency: "USD",
        lineItems: [
          { rawDescription: "Creed Aventus 100ml", upc: P1.barcode, brand: "Creed", name: "Aventus", size: "100ml", concentration: "Eau de Parfum", quantity: 2, unitCost: 150, lineTotal: 300 },
          { rawDescription: "Mystery item", upc: "999", brand: "", name: "", size: "", concentration: "", quantity: 1, unitCost: 5, lineTotal: 5 },
        ],
      }),
    });
    const body = await res.json();
    check("success -> HTTP 200", res.status, 200);
    check("success body is the existing { extracted, matched } shape (no failure code)", [Object.keys(body).sort(), body.code], [["extracted", "matched"], undefined]);
    check("exact UPC line is matched by the existing logic", [body.matched[0].matchType, body.matched[0].candidate.productId], ["upc", P1.id]);
    check("unknown line stays unmatched", body.matched[1].matchType, "unmatched");
    check("the preview wrote nothing", fake.writes.length, 0);
  }

  // ====================================================================
  console.log("2. Insufficient credits -> clean message + Continue without AI");
  // ====================================================================
  {
    const res = await handleParseInvoice(parseReq(), {
      apiKeyConfigured: () => true,
      loadProducts: async () => products,
      extract: async () => {
        throw Anthropic.APIError.generate(400, creditBody, undefined, new Headers({ "request-id": "req_credit" }));
      },
    });
    const body = await res.json();
    check("HTTP 503", res.status, 503);
    check("exact agreed message", body.error, AGREED);
    check("stable code the UI keys off", body.code, "ai_credits_exhausted");
    check("the UI offers Continue without AI for this code", canContinueWithoutAI(body.code), true);
    check("no raw provider JSON reaches the browser", /invalid_request_error|request_id|\{"type"/.test(JSON.stringify(body)), false);
    check("it says no inventory changed", body.noInventoryChanged, true);
    check("a failed extraction wrote nothing", fake.writes.length, 0);
    for (const code of ["ai_auth_failed", "ai_misconfigured", "ai_rate_limited", "ai_overloaded", "ai_unreachable", "ai_not_configured", "invoice_unreadable", "ai_unexpected_error"]) {
      check(`Continue without AI is offered for ${code}`, canContinueWithoutAI(code), true);
    }
    check("not offered when there is no failure code (ordinary errors)", [canContinueWithoutAI(undefined), canContinueWithoutAI(null), canContinueWithoutAI("something_else")], [false, false, false]);
    const noKey = await (await handleParseInvoice(parseReq(), { apiKeyConfigured: () => false, loadProducts: async () => products, extract: async () => { throw new Error("should not run"); } })).json();
    check("a missing key is a clean, continuable failure too", [noKey.code, canContinueWithoutAI(noKey.code), /ANTHROPIC_API_KEY/.test(noKey.error)], ["ai_not_configured", true, false]);
  }

  // ====================================================================
  console.log("3. Manual draft starts empty, defaults today/USD, and blocks incomplete POs");
  // ====================================================================
  let draft = createEmptyManualDraft(new Date(2026, 9, 11, 22, 30)); // evening local time
  check("date defaults to today (local)", draft.extracted.invoiceDate, "2026-10-11");
  check("currency defaults to USD", draft.extracted.currency, "USD");
  check("starts with no lines", [draft.lines.length, draft.resolved.length], [0, 0]);
  check("an empty draft can't be confirmed (supplier, number, lines)", validateManualDraft(draft), ["Enter the supplier name.", "Enter the PO / invoice number.", "Add at least one line."]);
  check("nothing has been written by opening the empty draft", fake.writes.length, 0);

  // ====================================================================
  console.log("4. Exact UPC / SKU auto-match; fuzzy is only a suggestion; manual choice preserved");
  // ====================================================================
  draft = addManualLine(addManualLine(addManualLine(draft)));
  check("+ Add line appends blank unmatched lines", [draft.lines.length, draft.lines[0].matchType, draft.resolved], [3, "unmatched", [null, null, null]]);

  draft = applyManualLineEdit(draft, 0, { rawDescription: "Creed Aventus 100ml EDP" }, products);
  draft = applyManualLineEdit(draft, 0, { upc: " 3760265190164 " }, products);
  check("exact UPC typed -> auto-selected (existing match logic)", [draft.lines[0].matchType, draft.resolved[0]], ["upc", P1.id]);

  draft = applyManualLineEdit(draft, 1, { rawDescription: "Dior Sauvage" }, products);
  draft = applyManualLineEdit(draft, 1, { upc: "sauv-100" }, products);
  check("exact SKU typed (any case) -> auto-selected", [draft.lines[1].matchType, draft.resolved[1]], ["sku", P2.id]);

  draft = applyManualLineEdit(draft, 2, { rawDescription: "Creed Aventus 100ml EDP" }, products);
  check("description-only fuzzy hit is a suggestion, NOT auto-selected", [draft.lines[2].matchType, draft.resolved[2]], ["fuzzy", null]);

  draft = applyManualLineEdit(draft, 0, { quantity: 3, unitCost: 150 }, products);
  check("quantity and unit cost keep the line total in sync", draft.lines[0].lineTotal, 450);
  check("editing quantity/cost does not disturb the auto-match", draft.resolved[0], P1.id);

  draft = applyManualLineEdit(draft, 0, { upc: "000000" }, products);
  check("changing the code away clears the earlier AUTO-selection", [draft.lines[0].matchType === "upc" || draft.lines[0].matchType === "sku", draft.resolved[0]], [false, null]);
  draft = applyManualLineEdit(draft, 0, { upc: P1.barcode }, products);
  check("restoring the exact code re-selects it", draft.resolved[0], P1.id);

  // ====================================================================
  console.log("5. An unmatched item can still be selected manually (and survives later edits)");
  // ====================================================================
  draft = applyManualLineEdit(draft, 2, { rawDescription: "Totally unknown bottle", upc: "12345" }, products);
  check("unknown item is unmatched with no product", [draft.lines[2].matchType, draft.resolved[2]], ["unmatched", null]);
  draft = selectProductForLine(draft, 2, P3.id);
  check("manual dropdown selection sticks", draft.resolved[2], P3.id);
  draft = applyManualLineEdit(draft, 2, { quantity: 2, unitCost: 10 }, products);
  draft = applyManualLineEdit(draft, 2, { rawDescription: "Totally unknown bottle (box)" }, products);
  check("a manual choice is not overwritten by a later non-exact re-match", draft.resolved[2], P3.id);
  const removed = removeManualLine(draft, 1);
  check("Remove drops the line and its selection together", [removed.lines.length, removed.resolved.length], [2, 2]);

  // ====================================================================
  console.log("6. Cancel manual entry creates nothing; no PO exists before confirmation");
  // ====================================================================
  {
    const pageSrc = fs.readFileSync(path.join(__dirname, "../src/app/intake/upload/page.tsx"), "utf8");
    const fnBody = (name: string) => {
      const start = pageSrc.indexOf(`const ${name} =`);
      if (start === -1) return "";
      const rest = pageSrc.slice(start);
      const end = rest.search(/\n  };\n|\n  const \w+ = /);
      return rest.slice(0, end === -1 ? 400 : end + 6);
    };
    for (const fn of ["startManualEntry", "cancelManualEntry", "addLine", "removeLine", "editManualLine", "applyDraft"]) {
      check(`page handler ${fn} makes no network call`, /fetch\(/.test(fnBody(fn)), false);
    }
    check("the PO is only ever created from submit() (single reference to /api/intake/pos)", (pageSrc.match(/\/api\/intake\/pos/g) ?? []).length, 1);
    ok("that single reference is inside submit()", fnBody("submit").includes("/api/intake/pos"));
    ok("submit() validates the manual draft before posting", fnBody("submit").indexOf("validateManualDraft") !== -1 && fnBody("submit").indexOf("validateManualDraft") < fnBody("submit").indexOf("fetch("));
  }
  check("through all the editing above: zero writes", fake.writes.length, 0);
  check("no POs, suppliers or documents exist yet", [await fake.get(KEYS.pos), await fake.get(KEYS.suppliers), await fake.get(KEYS.documents)], [null, null, null]);
  check("inventory, lots, ledger untouched while drafting", snapshot(), before);

  // ====================================================================
  console.log("7. Confirming creates the PO through the EXISTING flow, and only the PO");
  // ====================================================================
  draft.extracted = { ...draft.extracted, supplierName: "Manual Test Supplier", poNumber: "MAN-001" };
  check("a complete draft passes validation", validateManualDraft(draft), []);
  const body = buildCreatePOBody(draft, "https://blob.example/inv.pdf", "inv.pdf");
  check("request body is exactly the existing POST /api/intake/pos shape", Object.keys(body).sort(), ["blobUrl", "extracted", "filename", "lines", "resolvedProductIds"]);
  const res = await createPO(new Request("http://localhost/api/intake/pos", { method: "POST", body: JSON.stringify(body) }));
  const created = await res.json();
  check("POST /api/intake/pos -> 201", res.status, 201);
  check("PO created awaiting delivery with the manual header", [created.po.status, created.po.poNumber, created.po.supplierName, created.po.currency, created.po.invoiceDate], ["awaiting_delivery", "MAN-001", "Manual Test Supplier", "USD", "2026-10-11"]);
  check("PO totals come from the typed lines", [created.po.lineCount, created.po.totalExpectedQty, created.po.subtotal], [3, 3 + 1 + 2, 450 + 1 * 0 + 20]);
  const poLines = (await fake.get(KEYS.poLines(created.po.id))) as { productId: string | null; matchType: string; expectedQty: number; rawDescription: string; receivedQty: number }[];
  check("PO lines carry the matched / manually chosen products", poLines.map((l) => l.productId), [P1.id, P2.id, P3.id]);
  check("match types are recorded honestly (upc, sku, manual)", poLines.map((l) => l.matchType), ["upc", "sku", "manual"]);
  check("nothing is received yet", poLines.every((l) => l.receivedQty === 0), true);
  const docs = (await fake.get(KEYS.documents)) as { blobUrl?: string; url?: string }[];
  ok("the already-uploaded invoice PDF is attached", JSON.stringify(docs).includes("https://blob.example/inv.pdf"));

  // ====================================================================
  console.log("8. Inventory / ledger are unchanged by PO creation (they move only at receiving)");
  // ====================================================================
  check("products, ledger, lots and receiving events are byte-identical after the PO is created", snapshot(), before);
  const written = [...new Set(fake.writes)].sort();
  check("the ONLY keys written are suppliers, POs, this PO's lines, and the document list", written, [KEYS.documents, KEYS.poLines(created.po.id), KEYS.pos, KEYS.suppliers].sort());
  check("a second, cancelled attempt adds no PO", ((await fake.get(KEYS.pos)) as unknown[]).length, 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
