import { NextResponse } from "next/server";
import { getProduct, updateProduct } from "@/lib/db";
import { redis, KEYS as CoreKeys } from "@/lib/kv";
import { getAllInventoryTransactions, getLotsForProduct, newId, KEYS as IntakeKeys } from "@/lib/intake-db";
import type { InventoryLot, InventoryTransaction } from "@/lib/intake-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only. Same seed-lots pattern used for every prior
// phase's verification. Removed before merging this branch's PR.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const productId = typeof body?.productId === "string" ? body.productId : "";
  const lots = Array.isArray(body?.lots) ? body.lots : [];
  if (!productId) return NextResponse.json({ error: "Missing productId." }, { status: 400 });
  const product = await getProduct(productId);
  if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });
  if (!product.sku.includes("TEST_")) {
    return NextResponse.json({ error: "productId must reference a TEST_ product (checked via sku)." }, { status: 400 });
  }

  const existingLots = await getLotsForProduct(productId);
  const existingTxns = await getAllInventoryTransactions();
  const newLots: InventoryLot[] = [];
  const newTxns: InventoryTransaction[] = [];
  let totalQty = 0;

  for (const l of lots) {
    const lotId = newId("lot");
    const qty = Number(l.qty);
    const unitCost = Number(l.unitCost);
    totalQty += qty;
    newLots.push({
      id: lotId,
      poId: "TEST_PO",
      poNumber: "TEST-PO-1",
      poLineId: "TEST_LINE",
      productId,
      supplierId: "TEST_SUPPLIER",
      supplierName: "Test Supplier",
      unitCost,
      receivedQuantity: qty,
      receivedDate: l.receivedDate || new Date().toISOString(),
      invoiceDate: new Date().toISOString(),
    });
    newTxns.push({
      id: newId("txn"),
      productId,
      poId: "TEST_PO",
      poLineId: "TEST_LINE",
      lotId,
      quantityDelta: qty,
      reason: "po_receiving",
      receivingEventId: null,
      saleId: null,
      operator: "devtest",
      timestamp: new Date().toISOString(),
    });
  }

  await redis.set(IntakeKeys.lots(productId), [...existingLots, ...newLots]);
  await redis.set(IntakeKeys.inventoryTransactions, [...existingTxns, ...newTxns]);
  await updateProduct(productId, { inventory: product.inventory + totalQty });
  const currentProductVersion = (await redis.get<number>(CoreKeys.productVersion(productId))) ?? 0;
  await redis.set(CoreKeys.productVersion(productId), currentProductVersion + 1);

  return NextResponse.json({ ok: true, lots: newLots });
}
