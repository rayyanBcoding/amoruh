// Inventory Intake Mode — domain types.
//
// Everything here is additive to the existing catalog model in
// src/lib/types.ts. Product.cost and Product.inventory are never
// repurposed — see src/lib/intake-db.ts / src/lib/intake-receiving.ts for
// how lot "remaining" is derived purely from InventoryTransaction
// movements, never from Product.inventory.

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

export type PreferredOrderingMethod = "whatsapp" | "email" | "portal" | "excel" | "phone_agent";

/** Remembered spreadsheet layout for one supplier's price list — see
 *  pricing-parse.ts for how a new upload's header row is compared
 *  against `headerSignature` to decide whether to reuse this mapping or
 *  ask again. columnMap keys are the canonical fields Pricing/Ordering
 *  understands; values are the 0-based column index in that supplier's
 *  sheet. */
export interface SupplierColumnMapping {
  /** Which raw sheet row (0-based) holds the header — real supplier
   *  files often have preamble rows (company name, a date, a note)
   *  before the actual header, so this is never assumed to be row 0.
   *  Reuse on a later upload requires this exact row to still hold
   *  `headerSignature` below — see resolveHeaderRow/verifyHeaderSignature
   *  in pricing-parse.ts. */
  headerRowIndex: number;
  /** Normalized header row this mapping was confirmed against — used to
   *  detect "the layout changed" on a later upload. */
  headerSignature: string[];
  columnMap: {
    supplierSku?: number;
    description?: number;
    brand?: number;
    quantity?: number;
    price?: number;
    currency?: number;
    upc?: number;
    ean?: number;
    category?: number;
  };
  confirmedAt: string;
}

/** Supplier — extended, additive-only, from Phase 1's bare {id, name,
 *  createdAt}. Existing PurchaseOrder.supplierId / getOrCreateSupplier()
 *  callers are unaffected; a supplier created before Pricing/Ordering
 *  simply has undefined profile fields. */
export interface Supplier {
  id: string;
  name: string;
  createdAt: string;
  country?: string;
  defaultCurrency?: string;
  contactPerson?: string;
  email?: string;
  whatsapp?: string;
  website?: string;
  orderingMethod?: PreferredOrderingMethod;
  notes?: string;
  typicalShippingMethod?: string;
  /** Remembered from the last confirmed price-list upload — see
   *  SupplierColumnMapping above. One layout per supplier for Phase 1A. */
  columnMapping?: SupplierColumnMapping;
  /** Pre-selected (but always still editable) choice on the upload
   *  screen — most suppliers consistently send one or the other. */
  defaultUploadType?: "full" | "partial";
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
  /** Cumulative quantity actually received against this line so far (across receiving events). Can exceed expectedQty (overage). */
  receivedQty: number;
  status: POLineStatus;
  /** How the match to productId was made — surfaced in the review UI. */
  matchType: "upc" | "sku" | "fuzzy" | "manual" | "new_product" | "unmatched";
  matchConfidence: number | null;
  /** True for a line created via "Add Unexpected Item" during receiving — not on the original invoice. */
  isUnexpected?: boolean;
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
  /** Freight/shipping cost for the whole PO — kept separate from every
   *  line's unitCost, always. See intake-costing.ts for how it's spread
   *  across units. */
  shippingCost: number;
}

/** One cost layer, created when a PO line is first received and grown
 *  (receivedQuantity increases) by every subsequent partial delivery
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
  /** Purchase (supplier) unit cost only — freight is never merged in here. */
  unitCost: number;
  /** Cumulative quantity ever received into this lot (denormalized display total). */
  receivedQuantity: number;
  receivedDate: string;
  invoiceDate: string;
}

/** A cost breakdown for one unit — purchase + freight (+ future duty/other),
 *  always computed live from the lot's PO so a freight edit is reflected
 *  immediately everywhere, with no stored value to migrate. */
export interface CostBreakdown {
  purchase: number;
  freight: number;
  duty: number;
  other: number;
  landed: number;
}

/** Lot + its live cost breakdown + its remaining quantity, computed purely
 *  from InventoryTransaction movements against that lot (never from
 *  Product.inventory). */
export interface InventoryLotWithRemaining extends InventoryLot {
  remaining: number;
  cost: CostBreakdown;
}

export type ReceiveMethod = "barcode" | "manual" | "receive_all";
export type ReceivingEventType = "received" | "modify" | "not_received" | "unexpected";

/** Append-only audit record of one receiving action — every field §20 asks for. */
export interface ReceivingEvent {
  id: string;
  poId: string;
  poNumber: string;
  poLineId: string;
  productId: string | null;
  productName: string;
  sku: string;
  upc: string;
  type: ReceivingEventType;
  method: ReceiveMethod;
  /** Remaining-expected immediately BEFORE this event. */
  expectedQtyAtEvent: number;
  /** Physically received in THIS event only (not cumulative). */
  actualQty: number;
  /** actualQty - expectedQtyAtEvent: negative = short, positive = overage. */
  difference: number;
  /** Reason for a not_received or unexpected event. */
  reason: string;
  notes: string;
  /** Cost breakdown frozen at the moment of this event — permanent, never recalculated. */
  cost: CostBreakdown;
  operator: string;
  timestamp: string;
  /** Set for every event created by one Receive All action, so they can be grouped. */
  batchId: string | null;
  idempotencyKey: string;
}

export type InventoryTransactionReason =
  | "po_receiving"
  | "po_receive_all"
  | "po_unexpected_item"
  | "sale"
  | "manual_adjustment";

/** Append-only ledger entry for one inventory movement against one lot.
 *  quantityDelta is signed: positive = added to the lot, negative = consumed. */
export interface InventoryTransaction {
  id: string;
  productId: string;
  poId: string | null;
  poLineId: string | null;
  lotId: string;
  quantityDelta: number;
  reason: InventoryTransactionReason;
  receivingEventId: string | null;
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

// ---------------------------------------------------------------------
// Scan resolution (receiving)
// ---------------------------------------------------------------------

export type ScanStatus = "found" | "duplicate" | "unexpected" | "unknown";

export interface ScanResolution {
  status: ScanStatus;
  line: PurchaseOrderLine | null;
  productId: string | null;
}
