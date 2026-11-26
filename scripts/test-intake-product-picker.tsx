// npx tsx scripts/test-intake-product-picker.tsx
// DOM interactions and local search only; no Redis or receiving requests.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { indexIntakeProducts, searchIntakeProducts, type PickerProduct } from "../src/lib/intake-product-search";

const product = (id: string, patch: Partial<PickerProduct> = {}): PickerProduct => ({
  id, brand: "Coach", name: "Green", concentration: "Eau de Toilette", size: "100ml", condition: "New", inventory: 0, sku: `SKU-${id}`, barcode: `BAR-${id}`, ...patch,
});
const products = [
  product("partial", { brand: "Other", name: "Coach Green gift", sku: "PARTIAL-123456" }),
  product("name", { inventory: 7 }),
  product("tester", { name: "Green (Tester)", size: "60ml", barcode: "123456" }),
  product("sku", { brand: "Dior", name: "Sauvage", sku: "123456" }),
  product("accent", { brand: "Hermès", name: "Terre" }),
];
const index = indexIntakeProducts(products);
const ids = (q: string) => searchIntakeProducts(index, q).map((p) => p.id);
assert.deepEqual(ids("123456"), ["tester", "sku", "partial"], "exact barcode and SKU outrank partial codes");
assert.equal(ids("green")[0], "name", "exact product name outranks embedded name fragments");
assert.equal(ids("coach green")[0], "name", "brand/name prefix outranks embedded phrase");
assert.deepEqual(ids(" green COACH 60ml "), ["tester"], "case-insensitive multiword search across variant fields");
assert.deepEqual(ids("hermes"), ["accent"], "accent-insensitive brand search");
assert.deepEqual(ids("sku-name"), ["name"]);
assert.deepEqual(ids("BAR-NAME"), ["name"]);
assert.equal(ids("").length, products.length, "zero stock remains selectable");
assert.deepEqual(ids("nonexistent"), []);
assert.deepEqual(products.map((p) => p.inventory), [0,7,0,0,0], "search does not change stock");

async function main() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><button id="outside">Outside</button></body></html>', { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ProductPicker } = await import("../src/components/intake/ProductPicker");
  const root = createRoot(document.getElementById("root")!);
  const selected: string[] = [];
  const render = async (catalog = products, excludeId?: string) => act(async () => root.render(createElement(ProductPicker, { products: catalog, excludeId, onSelect: (id) => selected.push(id) })));
  const click = async (el: Element) => act(async () => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  const key = async (value: string) => act(async () => document.querySelector('input')!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
  const type = async (value: string) => act(async () => {
    const input = document.querySelector('input')!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const trigger = () => document.querySelector('[aria-haspopup="listbox"]')!;
  const options = () => [...document.querySelectorAll('[role="option"]')];
  await render();
  await click(trigger());
  assert.equal(document.activeElement?.getAttribute("role"), "combobox", "opening focuses search for typing/scanning");
  await type("coach green");
  assert.equal(options()[0].textContent?.includes("Stock: 7"), true);
  assert.match(options()[0].textContent!, /Eau de Toilette.*100ml.*Retail.*New.*Stock: 7/);
  assert.match(options()[0].textContent!, /SKU: SKU-name.*Barcode: BAR-name/);
  await key("ArrowDown");
  assert.match(options().find((p) => p.getAttribute('aria-selected') === 'true')!.textContent!, /Tester/);
  const activeId = document.querySelector('input')!.getAttribute('aria-activedescendant');
  assert.ok(document.getElementById(activeId!)?.getAttribute('aria-selected') === 'true');
  await key("Enter");
  assert.deepEqual(selected, ["tester"], "Enter selects highlighted result once");
  assert.equal(document.querySelector('input'), null);
  assert.equal(document.activeElement, trigger(), "selection restores trigger focus");
  await click(trigger());
  await type("123456");
  await key("ArrowDown"); await key("ArrowUp"); await key("Enter");
  assert.deepEqual(selected, ["tester", "tester"], "up/down operates on ranked filtered results");
  await click(trigger()); await type("nothing"); await key("ArrowDown"); await key("Enter");
  assert.equal(selected.length, 2, "empty result Enter cannot select stale option");
  assert.match(document.querySelector('[role="status"]')!.textContent!, /No products found/);
  await key("Escape");
  assert.equal(document.querySelector('input'), null);
  assert.equal(document.activeElement, trigger());
  await render(products, "tester"); await click(trigger()); await type("123456");
  assert.equal(options().some((p) => p.id.endsWith('-tester')), false, "current match can be excluded when changing");
  await click(options()[0]); assert.equal(selected.at(-1), "sku", "mouse selection uses same ranked results");
  await render(Array.from({ length: 100 }, (_, i) => product(String(i)))); await click(trigger());
  assert.equal(options().length, 30, "bounded DOM for large catalogs");
  assert.match(document.querySelector('[role="status"]')!.textContent!, /100 matches.*first 30/);
  await act(async () => document.getElementById('outside')!.focus());
  assert.equal(document.querySelector('input'), null, "Tab/outside focus closes picker");
  await act(async () => root.unmount()); dom.window.close();
  console.log("Intake picker: search/ranking, identity details, autofocus, keyboard, mouse, empty results, exclusion, bounded results and blur passed.");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
