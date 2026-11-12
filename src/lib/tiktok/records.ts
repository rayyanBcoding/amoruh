import { createHash } from "node:crypto";
import { tiktokKey } from "./config";
import { normalizeMoney } from "./money";
import { DENY_KEY } from "./sanitize";

// =====================================================================
// TikTok storage model (Milestone 2 data layer)
//
//   Room ─▶ Auction slot (room_id + seller_sku) ─▶ Order(+line item) ─▶ Match ─▶ (later) SaleRecord
//   Order ─▶ Package ─▶ Combine group (auto_combine_group_id)
//   AMORUH Live Session ─▶ (optional, explicit) Room(s)
//
// RULES
//  * TikTok data lives ONLY under `amoruh:tiktok:{env}:*` and is kept apart from
//    SaleRecords / inventory / catalog. Links are explicit string IDs.
//  * Every TikTok id is a STRING. Money is a decimal STRING (see money.ts).
//  * No buyer / recipient / contact data is ever stored (assertNoPersonalData).
//  * A slot is identified by (room_id, seller_sku) — seller_sku alone is NEVER unique.
//  * Order records are written only by the importer; match records only by matches.ts.
//  * Redis values are always JSON objects: Upstash auto-parses top-level numeric-looking
//    strings into JS numbers, which would corrupt 18-digit ids.
// =====================================================================

export const SCHEMA = 1 as const;
const enc = (s: string) => encodeURIComponent(s);

export const K = {
  order: (orderId: string) => tiktokKey(`order:${orderId}`),
  slot: (roomId: string, sellerSku: string) => tiktokKey(`slot:${roomId}:${enc(sellerSku)}`),
  match: (roomId: string, sellerSku: string) => tiktokKey(`match:${roomId}:${enc(sellerSku)}`),
  room: (roomId: string) => tiktokKey(`room:${roomId}`),
  rooms: () => tiktokKey("rooms"),
  group: (groupId: string) => tiktokKey(`group:${groupId}`),
  pkg: (packageId: string) => tiktokKey(`package:${packageId}`),
  sessionLink: (sessionId: string) => tiktokKey(`session_link:${enc(sessionId)}`),
  roomSession: (roomId: string) => tiktokKey(`room_session:${roomId}`),
  unslotted: () => tiktokKey("unslotted"),
  importLog: (runId: string) => tiktokKey(`import_log:${runId}`),
  imports: () => tiktokKey("imports"),
  importLock: () => tiktokKey("import_lock"),
} as const;

// ---------- paid state ----------

export type PaidState = "PAID" | "UNPAID_CANCELLED" | "CANCELLED_AFTER_PAID" | "UNPAID_OPEN";

export function paidStateOf(status: string | null, paidTime: unknown): PaidState {
  const paid = typeof paidTime === "number" && paidTime > 0;
  if (status === "CANCELLED") return paid ? "CANCELLED_AFTER_PAID" : "UNPAID_CANCELLED";
  return paid ? "PAID" : "UNPAID_OPEN";
}

// ---------- record types ----------

export interface OrderLineItem {
  lineItemId: string | null;
  roomId: string | null;
  /** seller_sku exactly as TikTok sent it — the auction number as a string. */
  sellerSku: string | null;
  auctionNo: number | null;
  skuName: string | null;
  productId: string | null;
  skuId: string | null;
  /** Decimal strings. */
  salePrice: string | null;
  originalPrice: string | null;
  sellerDiscount: string | null;
  platformDiscount: string | null;
  currency: string | null;
  displayStatus: string | null;
  packageId: string | null;
  trackingNumber: string | null;
}

/** Everything TikTok told us about an order (hashable; no bookkeeping). */
export interface OrderContent {
  schema: typeof SCHEMA;
  orderId: string;
  roomId: string | null;
  orderType: string | null;
  status: string | null;
  paidState: PaidState;
  /** unix seconds as sent by TikTok */
  createTime: number | null;
  paidTime: number | null;
  updateTime: number | null;
  cancelTime: number | null;
  cancelReason: string | null;
  cancellationInitiator: string | null;
  autoCombineGroupId: string | null;
  packageIds: string[];
  carrier: string | null;
  shippingType: string | null;
  deliveryOption: string | null;
  fulfillmentType: string | null;
  trackingNumbers: string[];
  lineItems: OrderLineItem[];
  anomalies: string[];
}

export interface StatusEntry {
  at: string;
  status: string | null;
  paidState: PaidState;
  updateTime: number | null;
}

export interface OrderRecord extends OrderContent {
  contentHash: string;
  version: number;
  firstSeenAt: string;
  lastChangedAt: string;
  statusHistory: StatusEntry[];
}

export type SlotState = "PAID" | "CONFLICT" | "UNPAID_OPEN" | "CANCELLED_AFTER_PAID" | "UNPAID_CANCELLED";

export interface SlotEntry {
  orderId: string;
  lineItemId: string | null;
}

export interface SlotRecord {
  schema: typeof SCHEMA;
  roomId: string;
  sellerSku: string;
  auctionNo: number | null;
  entries: SlotEntry[];
  state: SlotState;
  /** Only a slot with exactly one PAID order can be matched to a product. */
  matchable: boolean;
  activeEntry: SlotEntry | null;
  salePrice: string | null;
  currency: string | null;
  updatedAt: string;
}

export interface RoomRecord {
  schema: typeof SCHEMA;
  roomId: string;
  slots: { sellerSku: string; auctionNo: number | null }[];
  slotCount: number;
  orderCount: number;
  paidSlots: number;
  unpaidSlots: number;
  conflictSlots: number;
  auctionNoMin: number | null;
  auctionNoMax: number | null;
  firstOrderTime: number | null;
  lastOrderTime: number | null;
  updatedAt: string;
}

export interface RoomsIndex {
  schema: typeof SCHEMA;
  rooms: { roomId: string; firstOrderTime: number | null; lastOrderTime: number | null }[];
}

export interface GroupRecord {
  schema: typeof SCHEMA;
  autoCombineGroupId: string;
  orderIds: string[];
  packageIds: string[];
  roomIds: string[];
  slotKeys: { roomId: string; sellerSku: string }[];
  trackingNumbers: string[];
  carriers: string[];
  updatedAt: string;
}

export interface PackageRecord {
  schema: typeof SCHEMA;
  packageId: string;
  autoCombineGroupId: string | null;
  orderIds: string[];
  lineItemIds: string[];
  trackingNumbers: string[];
  carrier: string | null;
  shippingType: string | null;
  updatedAt: string;
}

// ---------- projection from a raw TikTok order ----------

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
const posNum = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : null);
const uniq = (xs: (string | null)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))].sort();

/** Explicit allow-list projection. Nothing outside these fields is ever copied. */
export function toOrderContent(rawOrder: unknown): OrderContent | null {
  const o = asObj(rawOrder);
  const orderId = str(o.id);
  if (!orderId) return null;
  const anomalies: string[] = [];
  const status = str(o.status);

  const money = (v: unknown, field: string): string | null => {
    if (v === undefined || v === null || v === "") return null;
    const m = normalizeMoney(v);
    if (m === null) anomalies.push(`BAD_MONEY:${field}`);
    return m;
  };

  const rawItems = Array.isArray(o.line_items) ? (o.line_items as unknown[]) : [];
  const lineItems: OrderLineItem[] = rawItems.map((raw) => {
    const li = asObj(raw);
    const sku = str(li.seller_sku);
    return {
      lineItemId: str(li.id),
      roomId: str(li.room_id) ?? str(o.room_id),
      sellerSku: sku,
      auctionNo: sku && /^\d+$/.test(sku) ? Number(sku) : null,
      skuName: str(li.sku_name),
      productId: str(li.product_id),
      skuId: str(li.sku_id),
      salePrice: money(li.sale_price, "salePrice"),
      originalPrice: money(li.original_price, "originalPrice"),
      sellerDiscount: money(li.seller_discount, "sellerDiscount"),
      platformDiscount: money(li.platform_discount, "platformDiscount"),
      currency: str(li.currency),
      displayStatus: str(li.display_status),
      packageId: str(li.package_id),
      trackingNumber: str(li.tracking_number),
    };
  });
  if (lineItems.length === 0) anomalies.push("NO_LINE_ITEMS");

  const rooms = uniq(lineItems.map((l) => l.roomId));
  let roomId: string | null = null;
  if (rooms.length === 1) roomId = rooms[0];
  else if (rooms.length === 0) anomalies.push("NO_ROOM_ID");
  else anomalies.push("MULTIPLE_ROOMS_IN_ORDER");

  const packages = Array.isArray(o.packages) ? (o.packages as unknown[]) : [];
  return {
    schema: SCHEMA,
    orderId,
    roomId,
    orderType: str(o.order_type),
    status,
    paidState: paidStateOf(status, o.paid_time),
    createTime: posNum(o.create_time),
    paidTime: posNum(o.paid_time),
    updateTime: posNum(o.update_time),
    cancelTime: posNum(o.cancel_time),
    cancelReason: str(o.cancel_reason) ?? str(asObj(rawItems[0]).cancel_reason),
    cancellationInitiator: str(o.cancellation_initiator),
    autoCombineGroupId: str(o.auto_combine_group_id),
    packageIds: uniq([...packages.map((p) => str(asObj(p).id)), ...lineItems.map((l) => l.packageId)]),
    carrier: str(o.shipping_provider) ?? str(asObj(rawItems[0]).shipping_provider_name),
    shippingType: str(o.shipping_type),
    deliveryOption: str(o.delivery_option_name),
    fulfillmentType: str(o.fulfillment_type),
    trackingNumbers: uniq([str(o.tracking_number), ...lineItems.map((l) => l.trackingNumber)]),
    lineItems,
    anomalies,
  };
}

// ---------- hashing ----------

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const contentHashOf = (c: OrderContent): string => createHash("sha256").update(stableStringify(c)).digest("hex");

// ---------- personal-data guard ----------

/** Throws if any KEY in the value looks like buyer / recipient / contact / secret data.
 *  Runs on every record before it is written, so a future code change cannot
 *  quietly start persisting personal data. */
export function assertNoPersonalData(value: unknown, path = "record"): void {
  if (Array.isArray(value)) return value.forEach((v, i) => assertNoPersonalData(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DENY_KEY.test(k)) throw new Error(`Refusing to store personal/sensitive field "${path}.${k}".`);
      assertNoPersonalData(v, `${path}.${k}`);
    }
  }
}

// ---------- slot derivation ----------

export interface SlotView {
  state: SlotState;
  matchable: boolean;
  activeEntry: SlotEntry | null;
  salePrice: string | null;
  currency: string | null;
}

/** State of a slot from the orders that claim it.
 *  PAID (exactly one paid order) > CONFLICT (2+ paid) > UNPAID_OPEN > CANCELLED_AFTER_PAID > UNPAID_CANCELLED. */
export function deriveSlot(entries: SlotEntry[], orders: Map<string, OrderRecord>): SlotView {
  const known = entries.map((e) => ({ e, o: orders.get(e.orderId) })).filter((x): x is { e: SlotEntry; o: OrderRecord } => !!x.o);
  const paid = known.filter((x) => x.o.paidState === "PAID");
  const priceOf = (x: { e: SlotEntry; o: OrderRecord }) => x.o.lineItems.find((l) => l.lineItemId === x.e.lineItemId) ?? x.o.lineItems[0];
  if (paid.length === 1) {
    const li = priceOf(paid[0]);
    return { state: "PAID", matchable: true, activeEntry: paid[0].e, salePrice: li?.salePrice ?? null, currency: li?.currency ?? null };
  }
  const none = { matchable: false, activeEntry: null, salePrice: null, currency: null };
  if (paid.length > 1) return { state: "CONFLICT", ...none };
  if (known.some((x) => x.o.paidState === "UNPAID_OPEN")) return { state: "UNPAID_OPEN", ...none };
  if (known.some((x) => x.o.paidState === "CANCELLED_AFTER_PAID")) return { state: "CANCELLED_AFTER_PAID", ...none };
  const li = known.length ? priceOf(known[known.length - 1]) : undefined;
  return { state: "UNPAID_CANCELLED", ...none, salePrice: li?.salePrice ?? null, currency: li?.currency ?? null };
}

// ---------- explicit match record (slot → AMORUH product) ----------

export type MatchState = "selected" | "confirmed" | "voided";
export type MatchHealth = "OK" | "STALE_ORDER_NOT_PAID" | "STALE_ORDER_CHANGED" | "STALE_SLOT_MISSING";

/** The ONLY thing a person decides: which AMORUH product sits in this auction slot.
 *  `confirmed`, `confirmedAt` and `saleRecordId` are reserved for the later milestone that
 *  creates SaleRecords through the existing sale path; nothing in this milestone sets them. */
export interface MatchRecord {
  schema: typeof SCHEMA;
  roomId: string;
  sellerSku: string;
  auctionNo: number | null;
  orderId: string;
  lineItemId: string | null;
  /** AMORUH product id (Product.id). */
  productId: string;
  state: MatchState;
  /** Snapshot of what TikTok said when the match was chosen (audit only). */
  tiktokSalePrice: string | null;
  currency: string | null;
  tiktokPaidState: PaidState;
  selectedAt: string;
  selectedBy: string | null;
  confirmedAt: string | null;
  saleRecordId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  version: number;
}

export interface SessionLink {
  schema: typeof SCHEMA;
  sessionId: string;
  roomIds: string[];
  updatedAt: string;
}

export interface RoomSessionLink {
  schema: typeof SCHEMA;
  roomId: string;
  sessionId: string;
  linkedAt: string;
}
