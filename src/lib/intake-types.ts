// Inventory Intake Mode — domain types.
//
// Everything here is additive to the existing catalog model in
// src/lib/types.ts. Nothing here changes Product.cost or Product.inventory —
// see src/lib/intake-db.ts for how lots derive their "remaining" quantity
// from those two existing fields instead of duplicating them.

export type POStatus =
  | "awaiting_delivery"
  | "partially_received"
  | "received"
  | "closed";

export type POLineStatus =
  | "pending"
  | "matched"
  | "received"
  | "partial"
  | "missing"
  | "overage"
  | "damaged";

export interface Supplier {
  id: string;
  name: string;
  createdAt: string;
}

export interface InvoiceDocument {
  id: string;
  poId: string | null;
  blobUrl: string;
  filename: string;
  uploadedAt: string;
}

export interface PurchaseOrderLine {
  id: string;
  poId: string;
  /** Null until the line is matched to a product (either confirmed-match or newly created). */
  productId: string | null;
  /** The line description exactly as extracted from the invoice PDF. */
  rawDescription: string;
  upc: string;
  brand: string;
  name: string;
  size: string;
  concentration: string;
  expectedQty: number;
  unitCost: number;
  lineTotal: number;
  /** Cumulative quantity actually received against this line so far (across receiving events). */
  receivedQty: number;
  status: POLineStatus;
  /** How the match to productId was made — surfaced in the review UI. */
  matchType: "upc" | "sku" | "fuzzy" | "manual" | "new_product" | "unmatched";
  matchConfidence: number | null;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  invoiceDate: string;
  expectedArrivalDate: string | null;
  currency: string;
  status: POStatus;
  invoiceDocumentId: string | null;
  createdAt: string;
  /** Denormalized for fast dashboard rendering without joining lines. */
  lineCount: number;
  totalExpectedQty: number;
  totalReceivedQty: number;
  subtotal: number;
}

/** One immutable cost layer, created when a PO line is first received and
 *  grown (receivedQuantity increases) by every subsequent partial delivery
 *  against the same line. unitCost never changes after creation — this is
 *  what makes cost-by-PO possible. */
export interface InventoryLot {
  id: string;
  poId: string;
  poNumber: string;
  poLineId: string;
  productId: string;
  supplierId: string;
  supplierName: string;
  unitCost: number;
  receivedQuantity: number;
  receivedDate: string;
  invoiceDate: string;
}

/** Derived (never stored) view of a lot plus how much of it is still on
 *  hand, per the FIFO depletion computed in intake-db.ts. */
export interface InventoryLotWithRemaining extends InventoryLot {
  remaining: number;
}

export type ReceivingEventType = "received" | "modify" | "not_received";

export interface ReceivingEvent {
  id: string;
  poId: string;
  poNumber: string;
  poLineId: string;
  productId: string | null;
  productName: string;
  type: ReceivingEventType;
  expectedQty: number;
  actualQty: number;
  difference: number;
  location: string;
  notes: string;
  operator: string;
  timestamp: string;
}

// ---------------------------------------------------------------------
// Parse/preview shapes — what the Claude-extraction step returns before
// anything is saved. Not persisted as-is; the Review screen turns a
// confirmed ExtractedPO into a real PurchaseOrder + PurchaseOrderLine[].
// ---------------------------------------------------------------------

export interface ExtractedLineItem {
  rawDescription: string;
  upc: string;
  brand: string;
  name: string;
  size: string;
  concentration: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
}

export interface ExtractedPO {
  poNumber: string;
  supplierName: string;
  invoiceDate: string;
  currency: string;
  lineItems: ExtractedLineItem[];
}

export type MatchType = "upc" | "sku" | "fuzzy" | "unmatched";

export interface MatchCandidate {
  productId: string;
  sku: string;
  brand: string;
  name: string;
  size: string;
  confidence: number;
}

export interface MatchedLineItem extends ExtractedLineItem {
  matchType: MatchType;
  /** Best candidate (if any) — for "fuzzy" this needs explicit confirm; for "unmatched" this is null. */
  candidate: MatchCandidate | null;
}
