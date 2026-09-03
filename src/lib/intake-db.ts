import { redis } from "./kv";
import type {
  InvoiceDocument,
  MatchedLineItem,
  PurchaseOrder,
  PurchaseOrderLine,
  POStatus,
  Supplier,
} from "./intake-types";
import type { ExtractedPO } from "./intake-types";

// ---------------------------------------------------------------------
// Inventory Intake Mode — data layer, additive to src/lib/db.ts.
//
// Same Redis-blob-per-collection convention as the rest of the app.
// PO lines are stored one key per PO (amoruh:intake:po_lines:{poId})
// since every read of them is already scoped to a single PO (PO Detail,
// Receiving) — see intake-lots.ts (Phase 2) for the per-product lot store,
// which is queried the other way (by productId, across POs).
// ---------------------------------------------------------------------

const KEYS = {
  suppliers: "amoruh:intake:suppliers",
  pos: "amoruh:intake:pos",
  poLines: (poId: string) => `amoruh:intake:po_lines:${poId}`,
  documents: "amoruh:intake:documents",
} as const;

function newId(prefix: string): string {
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
