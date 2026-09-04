import { redis } from "./kv";
import { computeCostBreakdown } from "./intake-costing";
import type {
  InventoryLot,
  InventoryLotWithRemaining,
  InventoryTransaction,
  InvoiceDocument,
  MatchedLineItem,
  PurchaseOrder,
  PurchaseOrderLine,
  POStatus,
  ReceivingEvent,
  Supplier,
} from "./intake-types";
import type { ExtractedPO } from "./intake-types";

// ---------------------------------------------------------------------
// Inventory Intake Mode — data layer, additive to src/lib/db.ts.
//
// Same Redis-blob-per-collection convention as the rest of the app.
// PO lines are stored one key per PO (amoruh:intake:po_lines:{poId})
// since every read of them is already scoped to a single PO (PO Detail,
// Receiving). Lots are stored one key per product (queried the other
// way — by productId, across every PO that ever shipped that product).
// Receiving events and inventory transactions are flat, append-only
// collections — small enough at this business's volume to read/filter
// in memory. See src/lib/intake-receiving.ts for how these are WRITTEN
// (a single atomic Lua script, never plain redis.set() calls, for
// anything that mutates inventory) — everything in this file is either
// pure reads or the non-inventory-affecting PO/line/document writes that
// were already safe as plain read-modify-write (Phase 1's pattern).
// ---------------------------------------------------------------------

export const KEYS = {
  suppliers: "amoruh:intake:suppliers",
  pos: "amoruh:intake:pos",
  poLines: (poId: string) => `amoruh:intake:po_lines:${poId}`,
  documents: "amoruh:intake:documents",
  lots: (productId: string) => `amoruh:intake:lots:${productId}`,
  receivingEvents: "amoruh:intake:receiving_events",
  inventoryTransactions: "amoruh:intake:inventory_transactions",
  idempotency: (key: string) => `amoruh:intake:idempotency:${key}`,
} as const;

export function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------

export async function getSuppliers(): Promise<Supplier[]> {
  return (await redis.get<Supplier[]>(KEYS.suppliers)) ?? [];
}

/** Finds a supplier by exact (case-insensitive) name, creating one if none exists. */
export async function getOrCreateSupplier(name: string): Promise<Supplier> {
  const trimmed = name.trim() || "Unknown Supplier";
  const suppliers = await getSuppliers();
  const existing = suppliers.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;

  const supplier: Supplier = { id: newId("sup"), name: trimmed, createdAt: new Date().toISOString() };
  await redis.set(KEYS.suppliers, [...suppliers, supplier]);
  return supplier;
}

// ---------------------------------------------------------------------
// Purchase Orders
// ---------------------------------------------------------------------

export async function getPOs(): Promise<PurchaseOrder[]> {
  return (await redis.get<PurchaseOrder[]>(KEYS.pos)) ?? [];
}

export async function getPO(id: string): Promise<PurchaseOrder | null> {
  const pos = await getPOs();
  return pos.find((p) => p.id === id) ?? null;
}

async function savePOs(pos: PurchaseOrder[]): Promise<void> {
  await redis.set(KEYS.pos, pos);
}

export async function getPOLines(poId: string): Promise<PurchaseOrderLine[]> {
  return (await redis.get<PurchaseOrderLine[]>(KEYS.poLines(poId))) ?? [];
}

export async function savePOLines(poId: string, lines: PurchaseOrderLine[]): Promise<void> {
  await redis.set(KEYS.poLines(poId), lines);
}

// ---------------------------------------------------------------------
// Invoice documents
// ---------------------------------------------------------------------

export async function getInvoiceDocuments(): Promise<InvoiceDocument[]> {
  return (await redis.get<InvoiceDocument[]>(KEYS.documents)) ?? [];
}

export async function getInvoiceDocument(id: string): Promise<InvoiceDocument | null> {
  const docs = await getInvoiceDocuments();
  return docs.find((d) => d.id === id) ?? null;
}

async function createInvoiceDocument(blobUrl: string, filename: string, poId: string | null): Promise<InvoiceDocument> {
  const docs = await getInvoiceDocuments();
  const doc: InvoiceDocument = {
    id: newId("doc"),
    poId,
    blobUrl,
    filename,
    uploadedAt: new Date().toISOString(),
  };
  await redis.set(KEYS.documents, [...docs, doc]);
  return doc;
}

// ---------------------------------------------------------------------
// Creating a PO from a confirmed Review screen — the point where an
// ExtractedPO + human-confirmed matches become real, persisted records.
// ---------------------------------------------------------------------

export async function createPOFromReview(input: {
  extracted: ExtractedPO;
  lines: MatchedLineItem[];
  /** Per-line decision made on the Review screen: confirmed productId to
   *  attach (existing match accepted, or a newly created product), or null
   *  to leave the line unmatched for now (resolvable later from PO Detail). */
  resolvedProductIds: (string | null)[];
  blobUrl: string;
  filename: string;
}): Promise<PurchaseOrder> {
  const { extracted, lines, resolvedProductIds, blobUrl, filename } = input;
  const supplier = await getOrCreateSupplier(extracted.supplierName);

  const poId = newId("po");
  const now = new Date().toISOString();

  const poLines: PurchaseOrderLine[] = lines.map((line, i) => {
    const productId = resolvedProductIds[i] ?? null;
    return {
      id: newId("pol"),
      poId,
      productId,
      rawDescription: line.rawDescription,
      upc: line.upc,
      brand: line.brand,
      name: line.name,
      size: line.size,
      concentration: line.concentration,
      expectedQty: Math.max(0, Math.round(line.quantity)),
      unitCost: numberOrZero(line.unitCost),
      lineTotal: numberOrZero(line.lineTotal),
      receivedQty: 0,
      status: "pending",
      matchType: productId ? (line.matchType === "unmatched" ? "manual" : line.matchType) : "unmatched",
      matchConfidence: line.candidate?.confidence ?? null,
    };
  });

  const doc = await createInvoiceDocument(blobUrl, filename, poId);

  const po: PurchaseOrder = {
    id: poId,
    poNumber: extracted.poNumber || `PO-${Date.now()}`,
    supplierId: supplier.id,
    supplierName: supplier.name,
    invoiceDate: extracted.invoiceDate || now.slice(0, 10),
    expectedArrivalDate: null,
    currency: extracted.currency || "USD",
    status: "awaiting_delivery",
    invoiceDocumentId: doc.id,
    createdAt: now,
    lineCount: poLines.length,
    totalExpectedQty: poLines.reduce((sum, l) => sum + l.expectedQty, 0),
    totalReceivedQty: 0,
    subtotal: poLines.reduce((sum, l) => sum + l.lineTotal, 0),
    shippingCost: 0,
  };

  const pos = await getPOs();
  await savePOs([...pos, po]);
  await savePOLines(poId, poLines);

  return po;
}

export async function updatePOStatus(poId: string, status: POStatus): Promise<void> {
  const pos = await getPOs();
  const idx = pos.findIndex((p) => p.id === poId);
  if (idx === -1) return;
  pos[idx] = { ...pos[idx], status };
  await savePOs(pos);
}

/** Freight is a simple, non-inventory-affecting field — safe as a plain
 *  read-modify-write, unlike anything that touches lots/transactions/
 *  Product.inventory (see intake-receiving.ts for those). */
export async function updatePOShippingCost(poId: string, shippingCost: number): Promise<PurchaseOrder | null> {
  const pos = await getPOs();
  const idx = pos.findIndex((p) => p.id === poId);
  if (idx === -1) return null;
  pos[idx] = { ...pos[idx], shippingCost: Math.max(0, shippingCost) };
  await savePOs(pos);
  return pos[idx];
}

/** Recomputes a PO's denormalized totals + status from its current lines.
 *  Called after any line mutation (matching, receiving). */
export async function recomputePOFromLines(poId: string): Promise<PurchaseOrder | null> {
  const [pos, lines] = await Promise.all([getPOs(), getPOLines(poId)]);
  const idx = pos.findIndex((p) => p.id === poId);
  if (idx === -1) return null;

  const totalExpectedQty = lines.reduce((sum, l) => sum + l.expectedQty, 0);
  const totalReceivedQty = lines.reduce((sum, l) => sum + l.receivedQty, 0);

  let status: POStatus = pos[idx].status;
  if (status !== "closed") {
    if (totalReceivedQty === 0) status = "awaiting_delivery";
    else if (totalReceivedQty >= totalExpectedQty) status = "received";
    else status = "partially_received";
  }

  pos[idx] = { ...pos[idx], totalExpectedQty, totalReceivedQty, lineCount: lines.length, status };
  await savePOs(pos);
  return pos[idx];
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && !Number.isNaN(value) ? value : 0;
}

// ---------------------------------------------------------------------
// Inventory lots (reads only — writes go through intake-receiving.ts's
// atomic Lua helper, never a plain redis.set() here, because they always
// happen alongside a Product.inventory change and a receiving event).
// ---------------------------------------------------------------------

export async function getLotsForProduct(productId: string): Promise<InventoryLot[]> {
  return (await redis.get<InventoryLot[]>(KEYS.lots(productId))) ?? [];
}

// ---------------------------------------------------------------------
// Receiving events (audit trail) and inventory transactions (ledger) —
// both flat, append-only collections. Reads only, same reasoning as lots.
// ---------------------------------------------------------------------

export async function getAllReceivingEvents(): Promise<ReceivingEvent[]> {
  return (await redis.get<ReceivingEvent[]>(KEYS.receivingEvents)) ?? [];
}

export async function getReceivingEvents(filter?: { poId?: string; productId?: string }): Promise<ReceivingEvent[]> {
  const events = await getAllReceivingEvents();
  const filtered = events.filter(
    (e) => (!filter?.poId || e.poId === filter.poId) && (!filter?.productId || e.productId === filter.productId)
  );
  return [...filtered].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getAllInventoryTransactions(): Promise<InventoryTransaction[]> {
  return (await redis.get<InventoryTransaction[]>(KEYS.inventoryTransactions)) ?? [];
}

async function getTransactionsForProduct(productId: string): Promise<InventoryTransaction[]> {
  const all = await getAllInventoryTransactions();
  return all.filter((t) => t.productId === productId);
}

/** A product's lots with their live cost breakdown and remaining
 *  quantity — remaining is purely sum(quantityDelta) across that lot's
 *  own InventoryTransactions. Never derived from, or checked against,
 *  Product.inventory. */
export async function getLotsWithRemaining(productId: string): Promise<InventoryLotWithRemaining[]> {
  const [lots, transactions, pos] = await Promise.all([
    getLotsForProduct(productId),
    getTransactionsForProduct(productId),
    getPOs(),
  ]);

  const remainingByLot = new Map<string, number>();
  for (const tx of transactions) {
    remainingByLot.set(tx.lotId, (remainingByLot.get(tx.lotId) ?? 0) + tx.quantityDelta);
  }
  const poById = new Map(pos.map((p) => [p.id, p]));

  return [...lots]
    .sort((a, b) => a.receivedDate.localeCompare(b.receivedDate))
    .map((lot) => {
      const po = poById.get(lot.poId);
      const cost = computeCostBreakdown(lot.unitCost, po ?? { shippingCost: 0, totalExpectedQty: 0 });
      return {
        ...lot,
        remaining: remainingByLot.get(lot.id) ?? 0,
        cost,
      };
    });
}
