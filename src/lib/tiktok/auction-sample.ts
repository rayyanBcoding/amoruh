import { getValidAccessToken } from "./auth";
import { callOpenApi } from "./client";
import { TIKTOK_API, TIKTOK_ENV, type TikTokEnv } from "./config";
import { getAuthorizedShops } from "./shops";
import { paidStateOf, type PaidState } from "./records";

// Milestone 1 validation: does (room_id, seller_sku) identify an AMORUH auction number?
//
// Read-only. Pulls a window of the most recent orders, PROJECTS each line item onto
// a fixed list of non-personal fields (an explicit allow-list — nothing else from
// the raw order is ever copied), and analyses the numbering per LIVE room.
// Nothing is stored; no SaleRecord / inventory / catalog code is touched.
//
// Projected, deliberately: ids (strings), room_id, seller_sku, sku_name, order_type,
// status, timestamps, line-item sale price (decimal STRING), combine group, package
// id, carrier, and only whether a tracking number exists (+ last 4 characters).
// Never projected: buyer_*, recipient_*, user_id, addresses, messages, payment method.

export const WINDOW_DEFAULT = 100;
export const WINDOW_MAX = 100;
export const PAGE_SIZE = 50;
export const ROWS_DEFAULT = 25;
export const ROWS_MAX = 60;

export type { PaidState };

export interface AuctionRow {
  orderId: string;
  lineItemId: string | null;
  roomId: string | null;
  /** seller_sku exactly as TikTok sent it (string). */
  sellerSku: string | null;
  /** seller_sku as a number when it is a plain integer, else null. */
  auctionNo: number | null;
  skuName: string | null;
  orderType: string | null;
  orderStatus: string | null;
  lineStatus: string | null;
  paidState: PaidState;
  createTime: string | null;
  paidTime: string | null;
  /** Line-item sale price: a decimal STRING (never parsed to a float here). */
  salePrice: string | null;
  currency: string | null;
  autoCombineGroupId: string | null;
  packageId: string | null;
  carrier: string | null;
  hasTracking: boolean;
  trackingLast4: string | null;
  cancelReason: string | null;
  cancellationInitiator: string | null;
  lineItemsInOrder: number;
}

export type ExceptionType =
  | "NON_AUCTION"
  | "NO_ROOM_ID"
  | "NON_NUMERIC_SKU"
  | "SKU_NAME_MISMATCH"
  | "DUPLICATE_AUCTION_NO_IN_ROOM"
  | "MULTI_LINE_ORDER"
  | "MISSING_SALE_PRICE"
  | "CANCELLED_AFTER_PAID";

export interface RoomSummary {
  roomId: string;
  rows: number;
  orders: number;
  paid: number;
  unpaidCancelled: number;
  auctionNoMin: number | null;
  auctionNoMax: number | null;
  distinctAuctionNos: number;
  firstCreate: string | null;
  lastCreate: string | null;
  /** True if the window also holds OLDER orders from a different room, i.e. this room is fully covered. */
  fullyCovered: boolean;
  /** Numbers missing between min and max — only reported for fully covered rooms (capped at 60). */
  missingNumbers: number[] | null;
  duplicateAuctionNos: { auctionNo: string; orderIds: string[] }[];
}

export interface CombineGroup {
  autoCombineGroupId: string;
  roomId: string | null;
  auctionNos: string[];
  orderIds: string[];
  packageIds: string[];
}

export interface AuctionAnalysis {
  windowOrders: number;
  windowRows: number;
  orderTypeCounts: Record<string, number>;
  focusRoomId: string | null;
  rooms: RoomSummary[];
  exceptions: { type: ExceptionType; orderId: string; roomId: string | null; sellerSku: string | null; detail: string }[];
  exceptionCounts: Record<string, number>;
  combineGroups: CombineGroup[];
}

// ---------- projection (pure) ----------

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
const isoOf = (v: unknown): string | null => (typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : null);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One row per line item. Only allow-listed, non-personal fields are copied. */
export function projectOrder(order: unknown): AuctionRow[] {
  const o = asObj(order);
  const orderId = str(o.id);
  if (!orderId) return [];
  const items = Array.isArray(o.line_items) && o.line_items.length ? (o.line_items as unknown[]) : [{}];
  const status = str(o.status);
  const orderTracking = str(o.tracking_number);
  return items.map((raw) => {
    const li = asObj(raw);
    const sku = str(li.seller_sku);
    const tracking = str(li.tracking_number) ?? orderTracking;
    const pkg = str(li.package_id) ?? str(asObj(Array.isArray(o.packages) ? o.packages[0] : null).id);
    return {
      orderId,
      lineItemId: str(li.id),
      roomId: str(li.room_id) ?? str(o.room_id),
      sellerSku: sku,
      auctionNo: sku && /^\d+$/.test(sku) ? Number(sku) : null,
      skuName: str(li.sku_name),
      orderType: str(o.order_type),
      orderStatus: status,
      lineStatus: str(li.display_status),
      paidState: paidStateOf(status, o.paid_time),
      createTime: isoOf(o.create_time),
      paidTime: isoOf(o.paid_time),
      salePrice: str(li.sale_price),
      currency: str(li.currency),
      autoCombineGroupId: str(o.auto_combine_group_id),
      packageId: pkg,
      carrier: str(o.shipping_provider) ?? str(li.shipping_provider_name),
      hasTracking: !!tracking,
      trackingLast4: tracking ? tracking.slice(-4) : null,
      cancelReason: str(o.cancel_reason) ?? str(li.cancel_reason),
      cancellationInitiator: str(o.cancellation_initiator),
      lineItemsInOrder: items.length,
    };
  });
}

// ---------- analysis (pure) ----------

export function analyzeAuctionRows(rows: AuctionRow[], orderCount: number): AuctionAnalysis {
  const orderTypeCounts: Record<string, number> = {};
  const seenOrders = new Set<string>();
  for (const r of rows) {
    if (seenOrders.has(r.orderId)) continue;
    seenOrders.add(r.orderId);
    const t = r.orderType ?? "(none)";
    orderTypeCounts[t] = (orderTypeCounts[t] ?? 0) + 1;
  }

  const exceptions: AuctionAnalysis["exceptions"] = [];
  const add = (type: ExceptionType, r: AuctionRow, detail: string) =>
    exceptions.push({ type, orderId: r.orderId, roomId: r.roomId, sellerSku: r.sellerSku, detail });

  for (const r of rows) {
    if (r.orderType !== "AUCTION") add("NON_AUCTION", r, `order_type=${r.orderType ?? "(none)"}`);
    if (!r.roomId) add("NO_ROOM_ID", r, "line item has no room_id");
    if (r.sellerSku === null || r.auctionNo === null) add("NON_NUMERIC_SKU", r, `seller_sku=${JSON.stringify(r.sellerSku)}`);
    else if (r.skuName !== null && r.skuName !== r.sellerSku) add("SKU_NAME_MISMATCH", r, `sku_name=${JSON.stringify(r.skuName)}`);
    if (r.lineItemsInOrder > 1) add("MULTI_LINE_ORDER", r, `${r.lineItemsInOrder} line items in this order`);
    if (r.salePrice === null) add("MISSING_SALE_PRICE", r, "no sale_price on line item");
    if (r.paidState === "CANCELLED_AFTER_PAID") add("CANCELLED_AFTER_PAID", r, "paid_time set but order is CANCELLED");
  }

  // Group by room.
  const byRoom = new Map<string, AuctionRow[]>();
  for (const r of rows) {
    if (!r.roomId) continue;
    (byRoom.get(r.roomId) ?? byRoom.set(r.roomId, []).get(r.roomId)!).push(r);
  }
  const ts = (r: AuctionRow) => (r.createTime ? Date.parse(r.createTime) : 0);

  const roomsRaw = [...byRoom].map(([roomId, rs]) => ({ roomId, rs, first: Math.min(...rs.map(ts)), last: Math.max(...rs.map(ts)) }));
  roomsRaw.sort((a, b) => b.last - a.last); // newest room first

  const rooms: RoomSummary[] = roomsRaw.map(({ roomId, rs, first, last }) => {
    const nos = rs.map((r) => r.auctionNo).filter((n): n is number => n !== null);
    const distinct = new Set(nos);
    const min = nos.length ? Math.min(...nos) : null;
    const max = nos.length ? Math.max(...nos) : null;
    // Fully covered only if some order in the window is OLDER than this room's first order
    // AND belongs to a different room (so the room cannot continue beyond the window).
    const fullyCovered = rows.some((r) => r.roomId && r.roomId !== roomId && ts(r) < first);
    let missing: number[] | null = null;
    if (fullyCovered && min !== null && max !== null) {
      missing = [];
      for (let n = min; n <= max && missing.length < 60; n++) if (!distinct.has(n)) missing.push(n);
    }
    const bySku = new Map<string, Set<string>>();
    for (const r of rs) if (r.sellerSku) (bySku.get(r.sellerSku) ?? bySku.set(r.sellerSku, new Set()).get(r.sellerSku)!).add(r.orderId);
    const dups = [...bySku].filter(([, ids]) => ids.size > 1).map(([auctionNo, ids]) => ({ auctionNo, orderIds: [...ids] }));
    for (const d of dups) {
      const r = rs.find((x) => x.sellerSku === d.auctionNo)!;
      add("DUPLICATE_AUCTION_NO_IN_ROOM", r, `auction ${d.auctionNo} appears on ${d.orderIds.length} orders in this room`);
    }
    return {
      roomId,
      rows: rs.length,
      orders: new Set(rs.map((r) => r.orderId)).size,
      paid: rs.filter((r) => r.paidState === "PAID").length,
      unpaidCancelled: rs.filter((r) => r.paidState === "UNPAID_CANCELLED").length,
      auctionNoMin: min,
      auctionNoMax: max,
      distinctAuctionNos: distinct.size,
      firstCreate: first ? new Date(first).toISOString() : null,
      lastCreate: last ? new Date(last).toISOString() : null,
      fullyCovered,
      missingNumbers: missing,
      duplicateAuctionNos: dups,
    };
  });

  // Combined packages: orders sharing auto_combine_group_id.
  const groups = new Map<string, AuctionRow[]>();
  for (const r of rows) if (r.autoCombineGroupId) (groups.get(r.autoCombineGroupId) ?? groups.set(r.autoCombineGroupId, []).get(r.autoCombineGroupId)!).push(r);
  const combineGroups: CombineGroup[] = [...groups]
    .filter(([, rs]) => new Set(rs.map((r) => r.orderId)).size > 1)
    .map(([autoCombineGroupId, rs]) => ({
      autoCombineGroupId,
      roomId: rs[0].roomId,
      auctionNos: [...new Set(rs.map((r) => r.sellerSku).filter((x): x is string => !!x))],
      orderIds: [...new Set(rs.map((r) => r.orderId))],
      packageIds: [...new Set(rs.map((r) => r.packageId).filter((x): x is string => !!x))],
    }));

  const exceptionCounts: Record<string, number> = {};
  for (const e of exceptions) exceptionCounts[e.type] = (exceptionCounts[e.type] ?? 0) + 1;

  return {
    windowOrders: orderCount,
    windowRows: rows.length,
    orderTypeCounts,
    focusRoomId: rooms[0]?.roomId ?? null,
    rooms,
    exceptions: exceptions.slice(0, 60),
    exceptionCounts,
    combineGroups: combineGroups.slice(0, 30),
  };
}

// ---------- fetch (read-only) ----------

async function searchPage(accessToken: string, shopCipher: string, pageToken?: string) {
  const { data, requestId } = await callOpenApi<{ orders?: unknown[]; next_page_token?: string }>({
    method: "POST",
    path: TIKTOK_API.orderSearchPath,
    accessToken,
    query: { shop_cipher: shopCipher, page_size: PAGE_SIZE, sort_field: "create_time", sort_order: "DESC", page_token: pageToken },
    body: {},
  });
  return { orders: data.orders ?? [], next: data.next_page_token || null, requestId };
}

export interface AuctionSample {
  generatedAt: string;
  env: TikTokEnv;
  shop: { name: string; region: string };
  requestIds: (string | null)[];
  analysis: AuctionAnalysis;
  /** Rows of the focus (newest) room, newest-first window trimmed to `rows`, then sorted by auction number. */
  focusRoomRows: AuctionRow[];
}

/** Newest-first orders (raw TikTok objects, in memory only), paged up to `windowSize`. Read-only. */
export async function fetchRecentOrdersRaw(windowSize: number): Promise<{ orders: unknown[]; requestIds: (string | null)[]; shop: { name: string; region: string } }> {
  const size = Math.min(Math.max(Math.floor(Number(windowSize)) || WINDOW_DEFAULT, PAGE_SIZE), WINDOW_MAX);
  const { accessToken, conn } = await getValidAccessToken();
  const shops = conn.shops.length ? conn.shops : (await getAuthorizedShops(accessToken)).shops;
  const shop = shops[0];
  if (!shop?.cipher) throw new Error("No authorized shop (with a shop cipher) found for this connection.");

  const orders: unknown[] = [];
  const requestIds: (string | null)[] = [];
  let token: string | undefined;
  while (orders.length < size) {
    const page = await searchPage(accessToken, shop.cipher, token);
    requestIds.push(page.requestId);
    orders.push(...page.orders);
    if (!page.next || page.orders.length === 0) break;
    token = page.next;
  }
  return { orders, requestIds, shop: { name: shop.name, region: shop.region } };
}

export async function fetchAuctionSample(opts: { rows?: number; window?: number } = {}): Promise<AuctionSample> {
  const rowsWanted = Math.min(Math.max(Math.floor(Number(opts.rows)) || ROWS_DEFAULT, 1), ROWS_MAX);
  const { orders, requestIds, shop } = await fetchRecentOrdersRaw(opts.window ?? WINDOW_DEFAULT);

  const rows = orders.flatMap(projectOrder);
  const analysis = analyzeAuctionRows(rows, orders.length);
  const focus = rows
    .filter((r) => r.roomId === analysis.focusRoomId)
    .sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""))
    .slice(0, rowsWanted)
    .sort((a, b) => (a.auctionNo ?? Infinity) - (b.auctionNo ?? Infinity));

  return { generatedAt: new Date().toISOString(), env: TIKTOK_ENV, shop, requestIds, analysis, focusRoomRows: focus };
}
