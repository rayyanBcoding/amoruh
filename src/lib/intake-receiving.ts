import { redis } from "./kv";
import { KEYS as CoreKeys } from "./kv";
import { getProducts, getVersion } from "./db";
import { computeCostBreakdown } from "./intake-costing";
import {
  KEYS,
  newId,
  getPO,
  getPOs,
  getPOLines,
  getLotsForProduct,
  getLotsWithRemaining,
  getAllReceivingEvents,
  getAllInventoryTransactions,
} from "./intake-db";
import type {
  InventoryLot,
  InventoryTransaction,
  POLineStatus,
  PurchaseOrder,
  PurchaseOrderLine,
  ReceiveMethod,
  ReceivingEvent,
  ScanResolution,
} from "./intake-types";
import type { Product } from "./types";

// ---------------------------------------------------------------------
// The one module every inventory-mutating Intake Mode action goes
// through. Two rules, everywhere in this file:
//
//  1. Load + validate + compute EVERY final value in plain TypeScript
//     first, with zero Redis writes, before anything is committed.
//  2. Commit everything through atomicWrite() — one Lua script that
//     checks-and-marks the idempotency key AND applies every data write
//     as a single atomic unit on the Redis server. See the Phase 2 plan
//     ("Revised: Lua idempotency flow") for why this replaced both
//     redis.multi() (isolation, not rollback) and an app-level-only
//     idempotency pre-check (has a TOCTOU race across concurrent
//     requests).
// ---------------------------------------------------------------------

export class ReceivingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReceivingError";
    this.status = status;
  }
}

interface Write {
  key: string;
  value: unknown;
}

const ATOMIC_WRITE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
for i = 2, #KEYS do
  redis.call('SET', KEYS[i], ARGV[i])
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

async function atomicWrite(idempotencyKey: string, resultId: string, writes: Write[]): Promise<string> {
  const keys = [KEYS.idempotency(idempotencyKey), ...writes.map((w) => w.key)];
  const args = [resultId, ...writes.map((w) => JSON.stringify(w.value))];
  const result = await redis.eval<(string | number)[], string>(ATOMIC_WRITE_SCRIPT, keys, args);
  return result;
}

/** Fast-path optimization only — NOT the source of duplicate protection.
 *  The Lua script's own GET-then-SET is the real authority (see above). */
async function checkIdempotencyFast(idempotencyKey: string): Promise<string | null> {
  return (await redis.get<string>(KEYS.idempotency(idempotencyKey))) ?? null;
}

async function getReceivingEventById(id: string): Promise<ReceivingEvent | null> {
  const events = await getAllReceivingEvents();
  return events.find((e) => e.id === id) ?? null;
}

function computeLineStatus(
  expectedQty: number,
  receivedQty: number,
  markMissingIfZero: boolean
): POLineStatus {
  if (receivedQty > expectedQty) return "overage";
  if (expectedQty > 0 && receivedQty === expectedQty) return "received";
  if (receivedQty > 0) return "partial";
  if (markMissingIfZero) return "missing";
  return "pending";
}

function growOrCreateLot(
  existingLots: InventoryLot[],
  params: {
    poId: string;
    poNumber: string;
    poLineId: string;
    productId: string;
    supplierId: string;
    supplierName: string;
    unitCost: number;
    qty: number;
    timestamp: string;
    invoiceDate: string;
  }
): { lots: InventoryLot[]; lot: InventoryLot } {
  const idx = existingLots.findIndex((l) => l.poLineId === params.poLineId);
  if (idx !== -1) {
    const lot: InventoryLot = { ...existingLots[idx], receivedQuantity: existingLots[idx].receivedQuantity + params.qty };
    const lots = [...existingLots];
    lots[idx] = lot;
    return { lots, lot };
  }
  const lot: InventoryLot = {
    id: newId("lot"),
    poId: params.poId,
    poNumber: params.poNumber,
    poLineId: params.poLineId,
    productId: params.productId,
    supplierId: params.supplierId,
    supplierName: params.supplierName,
    unitCost: params.unitCost,
    receivedQuantity: params.qty,
    receivedDate: params.timestamp,
    invoiceDate: params.invoiceDate,
  };
  return { lots: [...existingLots, lot], lot };
}

function recomputePOStatus(po: PurchaseOrder, totalReceivedQty: number, totalExpectedQty: number): PurchaseOrder["status"] {
  if (po.status === "closed") return "closed";
  if (totalReceivedQty === 0) return "awaiting_delivery";
  if (totalReceivedQty >= totalExpectedQty) return "received";
  return "partially_received";
}

// ---------------------------------------------------------------------
// Scan resolution — read-only, used by the barcode input on the
// Receiving screen. Never mutates anything.
// ---------------------------------------------------------------------

export async function resolvePOScan(poId: string, code: string): Promise<ScanResolution> {
  const normalized = code.trim().toUpperCase();
  const [lines, products] = await Promise.all([getPOLines(poId), getProducts()]);
  const product = products.find(
    (p) => p.barcode.toUpperCase() === normalized || p.sku.toUpperCase() === normalized
  );

  let line = lines.find((l) => l.upc.toUpperCase() === normalized);
  if (!line && product) {
    line = lines.find((l) => l.productId === product.id);
  }

  if (line) {
    const remaining = Math.max(0, line.expectedQty - line.receivedQty);
    if (remaining <= 0 && line.receivedQty > 0) {
      return { status: "duplicate", line, productId: line.productId };
    }
    return { status: "found", line, productId: line.productId };
  }

  if (product) {
    return { status: "unexpected", line: null, productId: product.id };
  }

  return { status: "unknown", line: null, productId: null };
}

// ---------------------------------------------------------------------
// Single-line receive — scan and manual "Confirm Received" both call
// this exact function through the same API route.
// ---------------------------------------------------------------------

export interface ReceiveInput {
  poId: string;
  poLineId: string;
  type: "received" | "modify" | "not_received";
  actualQty?: number;
  reason?: string;
  notes?: string;
  location?: string;
  method: ReceiveMethod;
  operator: string;
  idempotencyKey: string;
  batchId?: string | null;
}

export async function receiveAgainstLine(input: ReceiveInput): Promise<ReceivingEvent> {
  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    const event = await getReceivingEventById(fastReplay);
    if (event) return event;
  }

  const [po, lines, products] = await Promise.all([getPO(input.poId), getPOLines(input.poId), getProducts()]);
  if (!po) throw new ReceivingError("Purchase order not found.", 404);
  if (po.status === "closed") throw new ReceivingError("This PO is closed and can't receive more inventory.");

  const lineIdx = lines.findIndex((l) => l.id === input.poLineId);
  if (lineIdx === -1) throw new ReceivingError("Line not found on this PO.", 404);
  const line = lines[lineIdx];
  if (!line.productId) throw new ReceivingError("This line needs a product match before it can be received.");

  const product = products.find((p) => p.id === line.productId);
  if (!product) throw new ReceivingError("The matched product no longer exists.", 404);

  const timestamp = new Date().toISOString();
  const eventId = newId("rcv");

  const { writes, event } = await buildReceiveWrites({
    po,
    lines,
    lineIdx,
    line,
    product,
    products,
    type: input.type,
    actualQtyInput: input.actualQty,
    reason: input.reason,
    notes: input.notes,
    location: input.location,
    method: input.method,
    operator: input.operator,
    batchId: input.batchId ?? null,
    idempotencyKey: input.idempotencyKey,
    eventId,
    timestamp,
  });

  await atomicWrite(input.idempotencyKey, eventId, writes);
  return event;
}

// ---------------------------------------------------------------------
// Shared per-line computation — used by both receiveAgainstLine and
// receiveUnexpectedItem (which just inserts a new $0-expected line
// first, then receives against it through this same logic).
// ---------------------------------------------------------------------

async function buildReceiveWrites(params: {
  po: PurchaseOrder;
  lines: PurchaseOrderLine[];
  lineIdx: number;
  line: PurchaseOrderLine;
  product: Product;
  products: Product[];
  type: "received" | "modify" | "not_received";
  /** What gets recorded on the ReceivingEvent's `type` field — defaults
   *  to `type` above, but receiveUnexpectedItem overrides it to
   *  "unexpected" while still using "modify"'s quantity semantics. */
  eventType?: ReceivingEvent["type"];
  actualQtyInput?: number;
  reason?: string;
  notes?: string;
  location?: string;
  method: ReceiveMethod;
  operator: string;
  batchId: string | null;
  idempotencyKey: string;
  eventId: string;
  timestamp: string;
}): Promise<{ writes: Write[]; event: ReceivingEvent }> {
  const { po, line, product, timestamp, eventId } = params;
  const expectedRemaining = Math.max(0, line.expectedQty - line.receivedQty);

  let actualQty: number;
  let reason = params.reason?.trim() || "";
  switch (params.type) {
    case "received":
      actualQty = expectedRemaining;
      break;
    case "modify": {
      const value = Number(params.actualQtyInput);
      if (!Number.isFinite(value) || value < 0) throw new ReceivingError("Enter a valid received quantity.");
      actualQty = Math.round(value);
      break;
    }
    case "not_received":
      actualQty = 0;
      if (!reason) reason = "Missing";
      break;
    default:
      throw new ReceivingError("Unknown receiving action.");
  }

  const difference = actualQty - expectedRemaining;
  const cost = computeCostBreakdown(line.unitCost, po);
  const newReceivedQty = line.receivedQty + actualQty;
  const updatedLine: PurchaseOrderLine = {
    ...line,
    receivedQty: newReceivedQty,
    status: computeLineStatus(line.expectedQty, newReceivedQty, params.type === "not_received" && line.receivedQty === 0),
  };
  const updatedLines = [...params.lines];
  updatedLines[params.lineIdx] = updatedLine;

  const writes: Write[] = [];
  let productForEvent = product;

  if (actualQty > 0) {
    const existingLots = await getLotsForProduct(product.id);
    const { lots, lot } = growOrCreateLot(existingLots, {
      poId: po.id,
      poNumber: po.poNumber,
      poLineId: line.id,
      productId: product.id,
      supplierId: po.supplierId,
      supplierName: po.supplierName,
      unitCost: line.unitCost,
      qty: actualQty,
      timestamp,
      invoiceDate: po.invoiceDate,
    });
    writes.push({ key: KEYS.lots(product.id), value: lots });

    const transactions = await getAllInventoryTransactions();
    const transaction: InventoryTransaction = {
      id: newId("txn"),
      productId: product.id,
      poId: po.id,
      poLineId: line.id,
      lotId: lot.id,
      quantityDelta: actualQty,
      reason: params.method === "receive_all" ? "po_receive_all" : "po_receiving",
      receivingEventId: eventId,
      operator: params.operator?.trim() || "Unknown",
      timestamp,
    };
    writes.push({ key: KEYS.inventoryTransactions, value: [...transactions, transaction] });

    const productIdx = params.products.findIndex((p) => p.id === product.id);
    const updatedProducts = [...params.products];
    productForEvent = {
      ...product,
      inventory: product.inventory + actualQty,
      shelf: params.location?.trim() || product.shelf,
    };
    updatedProducts[productIdx] = productForEvent;
    writes.push({ key: CoreKeys.products, value: updatedProducts });

    const currentVersion = await getVersion();
    writes.push({ key: CoreKeys.version, value: currentVersion + 1 });
  }

  writes.push({ key: KEYS.poLines(po.id), value: updatedLines });

  const totalReceivedQty = updatedLines.reduce((s, l) => s + l.receivedQty, 0);
  const totalExpectedQty = updatedLines.reduce((s, l) => s + l.expectedQty, 0);
  const pos = await getPOs();
  const poIdx = pos.findIndex((p) => p.id === po.id);
  const updatedPOs = [...pos];
  updatedPOs[poIdx] = {
    ...pos[poIdx],
    totalReceivedQty,
    totalExpectedQty,
    status: recomputePOStatus(pos[poIdx], totalReceivedQty, totalExpectedQty),
  };
  writes.push({ key: KEYS.pos, value: updatedPOs });

  const event: ReceivingEvent = {
    id: eventId,
    poId: po.id,
    poNumber: po.poNumber,
    poLineId: line.id,
    productId: product.id,
    productName: `${productForEvent.brand} ${productForEvent.name}`,
    sku: productForEvent.sku,
    upc: productForEvent.barcode,
    type: params.eventType ?? params.type,
    method: params.method,
    expectedQtyAtEvent: expectedRemaining,
    actualQty,
    difference,
    reason,
    notes: params.notes?.trim() || "",
    cost,
    operator: params.operator?.trim() || "Unknown",
    timestamp,
    batchId: params.batchId,
    idempotencyKey: params.idempotencyKey,
  };
  const events = await getAllReceivingEvents();
  writes.push({ key: KEYS.receivingEvents, value: [...events, event] });

  return { writes, event };
}

// ---------------------------------------------------------------------
// Unexpected item (§14) — a product exists in AMORUH but wasn't on this
// PO. Creates a synthetic $0-expected line, then receives against it
// through the exact same buildReceiveWrites() logic.
// ---------------------------------------------------------------------

export interface ReceiveUnexpectedInput {
  poId: string;
  productId: string;
  quantity: number;
  cost: number;
  reason: string;
  method: ReceiveMethod;
  operator: string;
  idempotencyKey: string;
}

export async function receiveUnexpectedItem(input: ReceiveUnexpectedInput): Promise<ReceivingEvent> {
  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    const event = await getReceivingEventById(fastReplay);
    if (event) return event;
  }

  const [po, lines, products] = await Promise.all([getPO(input.poId), getPOLines(input.poId), getProducts()]);
  if (!po) throw new ReceivingError("Purchase order not found.", 404);
  if (po.status === "closed") throw new ReceivingError("This PO is closed.");

  const product = products.find((p) => p.id === input.productId);
  if (!product) throw new ReceivingError("Product not found.", 404);
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new ReceivingError("Enter a valid quantity.");
  if (!Number.isFinite(input.cost) || input.cost < 0) throw new ReceivingError("Enter a valid unit cost.");
  if (!input.reason?.trim()) throw new ReceivingError("A reason is required for an unexpected item.");

  const newLine: PurchaseOrderLine = {
    id: newId("pol"),
    poId: po.id,
    productId: product.id,
    rawDescription: `${product.brand} ${product.name} — unexpected item`,
    upc: product.barcode,
    brand: product.brand,
    name: product.name,
    size: product.size,
    concentration: product.concentration,
    expectedQty: 0,
    unitCost: input.cost,
    lineTotal: 0,
    receivedQty: 0,
    status: "pending",
    matchType: "manual",
    matchConfidence: null,
    isUnexpected: true,
  };
  const linesWithNew = [...lines, newLine];
  const timestamp = new Date().toISOString();
  const eventId = newId("rcv");

  // "modify" (not "received") on purpose: this line's expectedQty is 0,
  // so "received" would mean "receive 0" (expectedRemaining). "modify"
  // is exactly "receive this specific quantity regardless of expected."
  const { writes, event } = await buildReceiveWrites({
    po,
    lines: linesWithNew,
    lineIdx: linesWithNew.length - 1,
    line: newLine,
    product,
    products,
    type: "modify",
    eventType: "unexpected",
    actualQtyInput: input.quantity,
    reason: input.reason,
    notes: "Unexpected item — not on original invoice.",
    method: input.method,
    operator: input.operator,
    batchId: null,
    idempotencyKey: input.idempotencyKey,
    eventId,
    timestamp,
  });

  await atomicWrite(input.idempotencyKey, eventId, writes);
  return event;
}

// ---------------------------------------------------------------------
// Receive All (§6) — receives every remaining line on a PO exactly as
// expected, in one atomic batch under one shared idempotency key and
// one shared batchId. Blocked entirely if any line is still unmatched.
// ---------------------------------------------------------------------

export interface ReceiveAllInput {
  poId: string;
  operator: string;
  idempotencyKey: string;
}

export interface ReceiveAllResult {
  batchId: string;
  linesReceived: number;
  unitsReceived: number;
}

export async function receiveAll(input: ReceiveAllInput): Promise<ReceiveAllResult> {
  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    const events = await getAllReceivingEvents();
    const batchEvents = events.filter((e) => e.batchId === fastReplay);
    return {
      batchId: fastReplay,
      linesReceived: batchEvents.length,
      unitsReceived: batchEvents.reduce((s, e) => s + e.actualQty, 0),
    };
  }

  const [po, lines, products] = await Promise.all([getPO(input.poId), getPOLines(input.poId), getProducts()]);
  if (!po) throw new ReceivingError("Purchase order not found.", 404);
  if (po.status === "closed") throw new ReceivingError("This PO is closed.");

  const unmatchedCount = lines.filter((l) => !l.productId).length;
  if (unmatchedCount > 0) {
    throw new ReceivingError(
      `${unmatchedCount} product${unmatchedCount === 1 ? "" : "s"} ${unmatchedCount === 1 ? "requires" : "require"} review before this PO can be approved.`
    );
  }

  const remainingLines = lines.filter((l) => l.expectedQty - l.receivedQty > 0);
  const batchId = newId("batch");
  const timestamp = new Date().toISOString();

  const workingLines = [...lines];
  const workingProducts = [...products];
  const lotsByProduct = new Map<string, InventoryLot[]>();
  let allTransactions = await getAllInventoryTransactions();
  const existingEvents = await getAllReceivingEvents();
  const newEvents: ReceivingEvent[] = [];
  let anyInventoryChanged = false;

  for (const line of remainingLines) {
    const lineIdx = workingLines.findIndex((l) => l.id === line.id);
    const product = workingProducts.find((p) => p.id === line.productId);
    if (!product) continue; // shouldn't happen — every line is matched at this point

    const expectedRemaining = Math.max(0, line.expectedQty - line.receivedQty);
    const actualQty = expectedRemaining;
    const cost = computeCostBreakdown(line.unitCost, po);
    const eventId = newId("rcv");
    const newReceivedQty = line.receivedQty + actualQty;

    workingLines[lineIdx] = {
      ...line,
      receivedQty: newReceivedQty,
      status: computeLineStatus(line.expectedQty, newReceivedQty, false),
    };

    if (actualQty > 0) {
      anyInventoryChanged = true;
      if (!lotsByProduct.has(product.id)) {
        lotsByProduct.set(product.id, await getLotsForProduct(product.id));
      }
      const { lots, lot } = growOrCreateLot(lotsByProduct.get(product.id)!, {
        poId: po.id,
        poNumber: po.poNumber,
        poLineId: line.id,
        productId: product.id,
        supplierId: po.supplierId,
        supplierName: po.supplierName,
        unitCost: line.unitCost,
        qty: actualQty,
        timestamp,
        invoiceDate: po.invoiceDate,
      });
      lotsByProduct.set(product.id, lots);

      allTransactions = [
        ...allTransactions,
        {
          id: newId("txn"),
          productId: product.id,
          poId: po.id,
          poLineId: line.id,
          lotId: lot.id,
          quantityDelta: actualQty,
          reason: "po_receive_all",
          receivingEventId: eventId,
          operator: input.operator?.trim() || "Unknown",
          timestamp,
        },
      ];

      const productIdx = workingProducts.findIndex((p) => p.id === product.id);
      workingProducts[productIdx] = { ...workingProducts[productIdx], inventory: workingProducts[productIdx].inventory + actualQty };
    }

    newEvents.push({
      id: eventId,
      poId: po.id,
      poNumber: po.poNumber,
      poLineId: line.id,
      productId: product.id,
      productName: `${product.brand} ${product.name}`,
      sku: product.sku,
      upc: product.barcode,
      type: "received",
      method: "receive_all",
      expectedQtyAtEvent: expectedRemaining,
      actualQty,
      difference: actualQty - expectedRemaining,
      reason: "",
      notes: "Received via Receive All.",
      cost,
      operator: input.operator?.trim() || "Unknown",
      timestamp,
      batchId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  const writes: Write[] = [];
  for (const [productId, lots] of lotsByProduct) {
    writes.push({ key: KEYS.lots(productId), value: lots });
  }
  if (anyInventoryChanged) {
    writes.push({ key: KEYS.inventoryTransactions, value: allTransactions });
    writes.push({ key: CoreKeys.products, value: workingProducts });
    const currentVersion = await getVersion();
    writes.push({ key: CoreKeys.version, value: currentVersion + 1 });
  }
  writes.push({ key: KEYS.poLines(po.id), value: workingLines });

  const totalReceivedQty = workingLines.reduce((s, l) => s + l.receivedQty, 0);
  const totalExpectedQty = workingLines.reduce((s, l) => s + l.expectedQty, 0);
  const pos = await getPOs();
  const poIdx = pos.findIndex((p) => p.id === po.id);
  const updatedPOs = [...pos];
  updatedPOs[poIdx] = {
    ...pos[poIdx],
    totalReceivedQty,
    totalExpectedQty,
    status: recomputePOStatus(pos[poIdx], totalReceivedQty, totalExpectedQty),
  };
  writes.push({ key: KEYS.pos, value: updatedPOs });
  writes.push({ key: KEYS.receivingEvents, value: [...existingEvents, ...newEvents] });

  await atomicWrite(input.idempotencyKey, batchId, writes);

  return {
    batchId,
    linesReceived: newEvents.length,
    unitsReceived: newEvents.reduce((s, e) => s + e.actualQty, 0),
  };
}

// ---------------------------------------------------------------------
// Mark Sold hook (best-effort, never blocks a sale) — see the Phase 2
// plan's "Revised: InventoryLot / InventoryTransaction relationship."
// A single-key write (inventory_transactions only) — no multi-key
// coordination needed, so a plain redis.set() is fine here.
// ---------------------------------------------------------------------

export async function consumeFromOldestLot(productId: string, quantity: number, operator: string): Promise<boolean> {
  try {
    const lotsWithRemaining = await getLotsWithRemaining(productId);
    const lot = lotsWithRemaining.find((l) => l.remaining > 0);
    if (!lot) return false;

    const transactions = await getAllInventoryTransactions();
    const transaction: InventoryTransaction = {
      id: newId("txn"),
      productId,
      poId: lot.poId,
      poLineId: lot.poLineId,
      lotId: lot.id,
      quantityDelta: -Math.min(quantity, lot.remaining),
      reason: "sale",
      receivingEventId: null,
      operator,
      timestamp: new Date().toISOString(),
    };
    await redis.set(KEYS.inventoryTransactions, [...transactions, transaction]);
    return true;
  } catch {
    return false;
  }
}
