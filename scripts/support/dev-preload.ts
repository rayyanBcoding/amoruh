// Preload for a HERMETIC local dev server: `NODE_OPTIONS="--require tsx/cjs --require ./scripts/support/dev-preload.ts" next dev`
// Replaces the app's Redis with the in-memory FakeRedis (real Lua via fengari) and seeds a small
// catalog, so the Go Live UI can be exercised end to end with ZERO production reads/writes.
import { installFakeRedis } from "./fake-redis";

const fake = installFakeRedis();
const prod = (id: string, brand: string, name: string, size: string, inventory: number, barcode: string) => ({
  id, sku: barcode, barcode, brand, name, size, concentration: "Eau de Parfum", image: "", color: "#B89A5C", cost: 20, retailPrice: 100,
  marketPrice: 90, lootPrice: 80, minPrice: 40, topNotes: [], middleNotes: [], baseNotes: [], projection: "", longevity: "", description: "",
  condition: "New", shelf: "A1", inventory, authentic: true, tiktokListing: "", status: "active",
});
const catalog = [
  prod("p_ysl", "YSL", "Y EDP", "100ml", 12, "3614272050036"),
  prod("p_dior", "Dior", "Sauvage", "100ml", 8, "3348901250153"),
  prod("p_creed", "Creed", "Aventus", "100ml", 5, "3760265190164"),
  prod("p_legacy", "Legacy", "No-Cost Test", "50ml", 6, "9990000000001"),
];
const lot = (id: string, productId: string, unitCost: number, qty: number) => ({
  id, poId: `po_${productId}`, poNumber: "1", poLineId: `pol_${productId}`, productId, supplierId: "s", supplierName: "S",
  unitCost, receivedQuantity: qty, receivedDate: "2026-10-01T00:00:00.000Z", invoiceDate: "2026-10-01",
});
const recv = (lotId: string, productId: string, qty: number) => ({
  id: `txn_recv_${lotId}`, productId, poId: `po_${productId}`, poLineId: `pol_${productId}`, lotId, quantityDelta: qty, reason: "receiving",
  receivingEventId: null, saleId: null, operator: "seed", timestamp: "2026-10-01T00:00:00.000Z",
});
(async () => {
  await fake.set("amoruh:products", catalog);
  await fake.set("amoruh:intake:lots:p_ysl", [lot("lot_ysl", "p_ysl", 44, 12)]);
  await fake.set("amoruh:intake:lots:p_dior", [lot("lot_dior", "p_dior", 60, 8)]);
  await fake.set("amoruh:intake:lots:p_creed", [lot("lot_creed", "p_creed", 150, 5)]);
  await fake.set("amoruh:intake:inventory_transactions", [recv("lot_ysl", "p_ysl", 12), recv("lot_dior", "p_dior", 8), recv("lot_creed", "p_creed", 5)]);
  await fake.set("amoruh:intake:pos", ["p_ysl", "p_dior", "p_creed"].map((p) => ({ id: `po_${p}`, shippingCost: 0, totalExpectedQty: 10 })));
  console.log("[dev-preload] FakeRedis installed — hermetic, no production Redis in use");
})();
