import { NextResponse } from "next/server";
import { redis } from "@/lib/kv";
import { KEYS as IntakeKeys, getPOs, getAllReceivingEvents, newId } from "@/lib/intake-db";
import type { PurchaseOrder, ReceivingEvent } from "@/lib/intake-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only. Directly constructs a PurchaseOrder +
// ReceivingEvent pair with a chosen status/event type, bypassing the
// full intake/receiving flow — only needed to verify Dashboard's Recent
// Activity wording against known PO states. Removed before merging this
// branch's PR.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const poNumber: string = body?.poNumber || `TEST-${Date.now()}`;
  const status: PurchaseOrder["status"] = body?.status || "partially_received";
  const totalExpectedQty: number = Number(body?.totalExpectedQty ?? 100);
  const totalReceivedQty: number = Number(body?.totalReceivedQty ?? 24);
  const eventType: ReceivingEvent["type"] = body?.eventType || "received";
  const actualQty: number = Number(body?.actualQty ?? totalReceivedQty);

  if (!poNumber.startsWith("TEST-")) {
    return NextResponse.json({ error: "poNumber must start with TEST-" }, { status: 400 });
  }

  const poId = newId("po");
  const po: PurchaseOrder = {
    id: poId,
    poNumber,
    supplierId: "TEST_SUPPLIER",
    supplierName: "Test Supplier",
    invoiceDate: new Date().toISOString(),
    expectedArrivalDate: null,
    currency: "USD",
    status,
    invoiceDocumentId: null,
    createdAt: new Date().toISOString(),
    lineCount: 1,
    totalExpectedQty,
    totalReceivedQty,
    subtotal: 0,
    shippingCost: 0,
  };

  const event: ReceivingEvent = {
    id: newId("rcv"),
    poId,
    poNumber,
    poLineId: "TEST_LINE",
    productId: null,
    productName: "Test Product",
    sku: "TEST_SKU",
    upc: "",
    type: eventType,
    method: "manual",
    expectedQtyAtEvent: totalExpectedQty,
    actualQty,
    difference: actualQty - totalExpectedQty,
    reason: "",
    notes: "",
    cost: { purchase: 0, freight: 0, duty: 0, other: 0, landed: 0 },
    operator: "devtest",
    timestamp: new Date().toISOString(),
    batchId: null,
    idempotencyKey: newId("idem"),
  };

  const pos = await getPOs();
  await redis.set(IntakeKeys.pos, [...pos, po]);
  const events = await getAllReceivingEvents();
  await redis.set(IntakeKeys.receivingEvents, [...events, event]);

  return NextResponse.json({ ok: true, po, event });
}
