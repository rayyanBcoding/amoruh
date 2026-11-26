// Pure rules + actual default-card markup. No Redis, browser or AI requests.
// npm_config_cache=/tmp/amoruh-npm-cache npx --yes tsx scripts/test-live-copilot.tsx
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import seed from "../data/products.json";
import type { Product } from "../src/lib/types";
import type { CurrentProductFinancialsView } from "../src/context/LiveSessionContext";
import { advisoryFloor, copilotView, type CopilotHistory } from "../src/lib/live-copilot";
import { retailIdentity } from "../src/lib/retail-reference";
import { computeReorderIntelligence, type HistorySale } from "../src/lib/reorder-intelligence";
import { CompactCopilotCard } from "../src/components/golive/CompactCopilotCard";

const product = (patch: Partial<Product> = {}): Product => {
  const p = { ...seed[0], id: "strong", brand: "Afnan", name: "9PM", concentration: "Eau de Parfum", size: "50 mL",
    minPrice: 25, lootPrice: 50, retailPrice: 9999, inventory: 8,
    liveNotes: { keyNotes: ["Vanilla", "Apple", "Cinnamon", "Amber"], vibe: "Warm", bestFor: "Evenings", source: "manual", updatedAt: new Date().toISOString() },
    ...patch,
  } as Product;
  if (!("retailReference" in patch)) p.retailReference = {
    status: "verified", priceCents: 5500, referenceSize: "100 mL", currency: "USD",
    concentration: p.concentration, retailer: "Official brand website", sourceUrl: "https://us.afnan.com/products/9-pm",
    checkedAt: new Date().toISOString(), identityKey: retailIdentity(p), manuallyEdited: true, verificationNotes: "Fixture",
  };
  return p;
};
const financials: CurrentProductFinancialsView = { cost: 20, costSource: "weighted_landed", breakEven: { status: "ok", breakEven: 22.25 }, lastSoldPrice: 50, averageAuction: 50 };
const ready: CopilotHistory = { state: "ready", row: null };
const base = product();
const before = JSON.stringify({ base, financials });
const view = (p = base, h = ready, f: CurrentProductFinancialsView | null = financials) => copilotView(p, f, h);
assert.equal(view().name, "Afnan 9PM");
assert.equal(view().concentration, "EDP");
assert.deepEqual(view().keyNotes, ["Vanilla", "Apple", "Cinnamon"]);
assert.equal(view().floor?.value, 25);
assert.equal(view().status.label, "✅ Good to run");
assert.equal(advisoryFloor({ minPrice: 0 }, financials)?.value, 24); // 20 / .85, rounded up
assert.equal(advisoryFloor({ minPrice: 30 }, financials)?.value, 30);
assert.equal(advisoryFloor({ minPrice: 0 }, { ...financials, breakEven: { status: "ok", breakEven: 28.1 } })?.value, 29);
for (const cost of [null, 0, -1, NaN, Infinity]) assert.equal(advisoryFloor(base, { ...financials, cost }), null);
for (const minPrice of [-1, NaN, Infinity]) assert.equal(advisoryFloor({ minPrice }, financials), null);
assert.equal(advisoryFloor(base, null), null);
assert.equal(advisoryFloor(base, { ...financials, costSource: "unavailable" }), null);
assert.equal(advisoryFloor(base, { ...financials, breakEven: { status: "not_configured" } }), null);
assert.equal(view(base, ready, null).status.label, "⚠️ Data review");
assert.equal(view(base, ready, { ...financials, costSource: "legacy" }).status.label, "⚠️ Data review");
for (const retailReference of [undefined, null, { ...base.retailReference!, status: "not_verified" as const, priceCents: null },
  { ...base.retailReference!, checkedAt: "2020-01-01" }, { ...base.retailReference!, identityKey: "other" },
  { ...base.retailReference!, sourceUrl: "https://www.fragrancenet.com/" }]) {
  assert.equal(view(product({ retailReference })).retail, null);
  assert.equal(view(product({ retailReference })).status.label, "⚠️ Data review");
}
assert.equal(view(product({ size: "10 mL", retailPrice: 1 })).floor?.value, view().floor?.value);
const highRetail = product(); highRetail.retailReference!.priceCents = 900000;
assert.equal(view(highRetail).floor?.value, view().floor?.value);
assert.equal(view(highRetail).status.label, "✅ Good to run"); // expensive retail is not demand
const flagged = product({ liveNotes: { ...base.liveNotes!, check: true } });
assert.equal(view(flagged).notesNeedReview, true);
assert.equal(view(flagged).status.label, "⚠️ Data review");
assert.equal(view(product({ liveNotes: undefined, sellingKeyNotes: [], fragranceNotes: [], topNotes: [], middleNotes: [], baseNotes: [] })).keyNotes.length, 0);
assert.equal(view(base, { state: "loading", row: null }).status.label, "⚠️ Data review");
assert.equal(view(base, { state: "unavailable", row: null }).status.label, "⚠️ Data review");

// Use the actual Reorder engine with real-sale-shaped rows, including multi-unit
// totals and cancelled/refunded records; no separate seller scoring engine.
const sessions = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `LIVE ${i}`, startedAt: new Date(Date.UTC(2026, 10, 1 + i)).toISOString() }));
const sales: HistorySale[] = [];
for (let i = 0; i < sessions.length; i++) for (const [id, units] of [["strong", 10], ["medium", 6], ["slow", i === 1 ? 3 : 0]] as const) {
  if (units) sales.push({ saleId: `${id}-${i}`, sessionId: `s${i}`, productId: id, quantity: units, price: units * 50, landedCostAtSale: 20,
    soldAt: sessions[i].startedAt, status: "completed", liveOrderNumber: i + 1 });
}
for (const status of ["canceled", "refunded"] as const) sales.push({ ...sales[0], saleId: status, productId: "phantom", quantity: 1000, status });
const scored = computeReorderIntelligence({ sessions, sales, products: ["strong", "medium", "slow", "phantom"].map((id) => ({ id, name: id, brand: "Afnan", sku: id, barcode: id, inventory: 8, size: "50 mL" })), window: "last5" });
assert.equal(scored.rows.find((r) => r.productId === "phantom"), undefined);
const strong = scored.rows.find((r) => r.productId === "strong")!;
const slow = scored.rows.find((r) => r.productId === "slow")!;
assert.equal(strong.units, 50); // last 5, not all 6; average is per unit, not per auction total
assert.equal(strong.avgSellingPrice, 50);
assert.equal(strong.bucket, "Hot + Profitable");
assert.equal(slow.bucket, "Weak Performer");
assert.equal(view(base, { state: "ready", row: strong }).status.label, "🔥 Strong seller");
assert.equal(view(base, { state: "ready", row: { ...strong, costCoverage: 0.75 } }).status.label, "⚠️ Data review");
assert.equal(view(product({ id: "slow" }), { state: "ready", row: slow }).status.label, "🐌 Slow mover");
assert.equal(view(product({ id: "slow" }), { state: "ready", row: { ...slow, units: 1 } }).status.label, "✅ Good to run");
assert.equal(view(product({ id: "slow" }), { state: "ready", row: { ...slow, breakdown: { ...slow.breakdown, demand: 50 } } }).status.label, "✅ Good to run");
assert.equal(view(base, { state: "ready", row: slow }).status.label, "✅ Good to run"); // stale different product
assert.equal(view(product({ inventory: 2 }), { state: "ready", row: strong }).status.label, "📦 Low stock");
assert.equal(view(product({ inventory: 2, retailReference: undefined }), { state: "ready", row: strong }).status.label, "⚠️ Data review");
assert.equal(view(product({ inventory: 0 })).status.label, "⚠️ Data review");
assert.equal(view(product({ inventory: 1, minPrice: 10, liveNotes: flagged.liveNotes }), { state: "ready", row: strong }).status.label, "⚠️ Protect price");
assert.equal(view(base, { state: "ready", row: { ...strong, margin: -0.1, units: 1 } }).status.label, "⚠️ Protect price");

const render = (p: Product, f: CurrentProductFinancialsView | null = financials) => renderToStaticMarkup(createElement(CompactCopilotCard, { product: p, financials: f, history: ready }));
const html = render(base);
assert.match(html, /Afnan 9PM/);
assert.match(html, /Vanilla • Apple • Cinnamon/);
assert.doesNotMatch(html, /Amber/);
assert.match(html, /Retail: \$55 \(100 mL\)/);
assert.match(html, /Floor: \$25/);
assert.equal((html.match(/role="status"/g) ?? []).length, 1);
assert.match(html, /aria-expanded="false"/);
for (const hidden of [/Print Label/, /Actual item cost/, /<img/, /Shelf/, /Best for/, /Real LIVE history/, /Source:/, /Evenings/, /\$9,999/]) assert.doesNotMatch(html, hidden);
assert.match(render(flagged), /Notes: check before quoting/);
assert.doesNotMatch(render(flagged), /Vanilla • Apple/);
assert.match(render(product({ retailReference: undefined })), /Retail: Not verified/);
assert.match(render(base, null), /Floor: Review/);
assert.equal(JSON.stringify({ base, financials }), before);
console.log("Copilot: actual-item floor, verified-only retail, notes flags, all six status priorities, real Reorder history/window/cancellation rules, safe missing-data fallbacks and collapsed default markup passed.");
