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
const NAMES: [string, string, string, number, number][] = [
  // brand, name, size, unit cost, stock
  ["Dolce & Gabbana", "Light Blue", "3.3oz", 29, 0], ["Armaf", "Club De Nuit Intense", "3.6oz", 21, 1], ["Lattafa", "Qaed Al Fursan", "90ml", 13, 3],
  ["Lattafa", "Yara Moi", "100ml", 18, 7], ["Rasasi", "Hawas Ice", "3.38oz", 27, 0], ["Afnan", "9 PM", "3.4oz", 23, 0],
  ["Paco Rabanne", "1 Million (tester)", "3.4oz", 44, 0], ["Burberry", "Touch", "3.3oz", 22, 2], ["Creed", "Wind Flowers", "30ml", 70, 4],
  ["Parfums de Marly", "Layton Exclusif", "125ml", 185, 2], ["Calvin Klein", "CK IN2U", "50ml", 17, 16], ["Mont Blanc", "Legend Red (Tester)", "3.4oz", 0, 0],
];
const catalog = NAMES.map(([brand, name, size, , stock], i) => prod(`p_${i}`, brand, name, size, stock, `99900000${String(i).padStart(2, "0")}`));
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
  const lotWrites: Promise<unknown>[] = [];
  const txns: unknown[] = [];
  const pos: unknown[] = [];
  NAMES.forEach(([, , , cost], i) => {
    if (cost === 0) return; // legacy product with no lot data (cost unknown)
    txns.push(recv(`lot_${i}`, `p_${i}`, 400));
    pos.push({ id: `po_p_${i}`, shippingCost: 0, totalExpectedQty: 400 });
    lotWrites.push(fake.set(`amoruh:intake:lots:p_${i}`, [lot(`lot_${i}`, `p_${i}`, cost, 400)]));
  });
  await Promise.all(lotWrites);
  await fake.set("amoruh:intake:inventory_transactions", txns);
  await fake.set("amoruh:intake:pos", pos);
  console.log("[dev-preload] FakeRedis installed — hermetic, no production Redis in use");
})();
