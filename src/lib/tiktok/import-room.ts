import { getValidAccessToken } from "./auth";
import { analyzeAuctionRows, projectOrder, searchPage } from "./auction-sample";
import { getRoom, importOrders, type ImportSummary } from "./order-store";
import { toOrderContent } from "./records";
import { getAuthorizedShops } from "./shops";

// Bounded, per-room import: store ONE complete TikTok LIVE room.
//
// Read-only toward TikTok (Order Search only). It pages newest-first FROM THE TOP, so
// nothing newer than the room can be missed, collects the orders whose line items carry
// the requested room_id, and stops once the room's start boundary is confirmed:
//   * "streak"    — `boundaryConfirm` consecutive orders that are NOT in this room appeared
//                   after the room was entered (rooms do not overlap in time, so the room
//                   is behind us), or
//   * "exhausted" — TikTok has no more orders.
// A single stray non-room order inside the room does not end the scan.
//
// NOT a backfill: hard limits (pages, orders inspected, runtime) apply and, if ANY limit
// is hit — or the order list is not newest-first, or the room is never found — the scan
// throws RoomImportError and NOTHING is written. A partial room is never stored.
// Importing reuses importOrders(): idempotent, allow-list projection (no buyer data),
// string ids, decimal-string money, compound slot key (room_id, seller_sku), unpaid /
// cancelled preserved but not matchable. No SaleRecord, inventory or profit code runs.

export interface RoomScanLimits {
  maxPages: number;
  maxOrdersInspected: number;
  maxRuntimeMs: number;
  boundaryConfirm: number;
}

export const ROOM_LIMIT_DEFAULTS: RoomScanLimits = { maxPages: 10, maxOrdersInspected: 600, maxRuntimeMs: 40_000, boundaryConfirm: 8 };
/** Callers can raise limits, but never past these ceilings. */
export const ROOM_LIMIT_CEILING: RoomScanLimits = { maxPages: 20, maxOrdersInspected: 1000, maxRuntimeMs: 55_000, boundaryConfirm: 50 };

export type RoomImportErrorCode =
  | "BAD_ROOM_ID"
  | "MAX_PAGES"
  | "MAX_ORDERS_INSPECTED"
  | "MAX_RUNTIME"
  | "ROOM_NOT_FOUND"
  | "ORDER_NOT_NEWEST_FIRST";

export interface ScanStats {
  pages: number;
  inspected: number;
  roomOrders: number;
  entered: boolean;
  boundary: "streak" | "exhausted" | null;
  boundaryConfirm: number;
  firstRoomOrderTime: number | null;
  lastRoomOrderTime: number | null;
  requestIds: (string | null)[];
  elapsedMs: number;
}

export class RoomImportError extends Error {
  constructor(public code: RoomImportErrorCode, message: string, public stats: ScanStats | null = null) {
    super(message);
    this.name = "RoomImportError";
  }
}

export interface OrderPage {
  orders: unknown[];
  next: string | null;
  requestId: string | null;
}

export function resolveLimits(partial: Partial<RoomScanLimits> = {}): RoomScanLimits {
  const pick = (v: unknown, def: number, ceil: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, ceil) : def;
  };
  return {
    maxPages: pick(partial.maxPages, ROOM_LIMIT_DEFAULTS.maxPages, ROOM_LIMIT_CEILING.maxPages),
    maxOrdersInspected: pick(partial.maxOrdersInspected, ROOM_LIMIT_DEFAULTS.maxOrdersInspected, ROOM_LIMIT_CEILING.maxOrdersInspected),
    maxRuntimeMs: pick(partial.maxRuntimeMs, ROOM_LIMIT_DEFAULTS.maxRuntimeMs, ROOM_LIMIT_CEILING.maxRuntimeMs),
    boundaryConfirm: pick(partial.boundaryConfirm, ROOM_LIMIT_DEFAULTS.boundaryConfirm, ROOM_LIMIT_CEILING.boundaryConfirm),
  };
}

/** Pure scan over an injected page fetcher (so it is testable without TikTok). */
export async function scanForRoom(args: {
  roomId: string;
  fetchPage: (pageToken?: string) => Promise<OrderPage>;
  limits?: Partial<RoomScanLimits>;
  now?: () => number;
}): Promise<{ roomOrders: unknown[]; stats: ScanStats }> {
  const { roomId } = args;
  if (!/^\d+$/.test(roomId)) throw new RoomImportError("BAD_ROOM_ID", "room_id must be a numeric string.");
  const limits = resolveLimits(args.limits);
  const now = args.now ?? Date.now;
  const started = now();

  const roomOrders: unknown[] = [];
  const stats: ScanStats = { pages: 0, inspected: 0, roomOrders: 0, entered: false, boundary: null, boundaryConfirm: limits.boundaryConfirm, firstRoomOrderTime: null, lastRoomOrderTime: null, requestIds: [], elapsedMs: 0 };
  const snapshot = (): ScanStats => ({ ...stats, roomOrders: roomOrders.length, requestIds: [...stats.requestIds], elapsedMs: now() - started });
  const where = () => (stats.entered ? "The room was found but its start boundary was not confirmed" : "The room was not reached yet");

  let token: string | undefined;
  let streak = 0;
  let lastCreate = Infinity;

  for (;;) {
    if (stats.pages >= limits.maxPages) throw new RoomImportError("MAX_PAGES", `Page limit (${limits.maxPages}) reached. ${where()}. Nothing was imported.`, snapshot());
    if (now() - started > limits.maxRuntimeMs) throw new RoomImportError("MAX_RUNTIME", `Runtime limit (${limits.maxRuntimeMs} ms) reached. ${where()}. Nothing was imported.`, snapshot());

    const page = await args.fetchPage(token);
    stats.pages++;
    stats.requestIds.push(page.requestId);

    for (const raw of page.orders) {
      if (stats.inspected >= limits.maxOrdersInspected) throw new RoomImportError("MAX_ORDERS_INSPECTED", `Inspected-orders limit (${limits.maxOrdersInspected}) reached. ${where()}. Nothing was imported.`, snapshot());
      stats.inspected++;
      const c = toOrderContent(raw);
      const t = c?.createTime ?? null;
      if (t !== null) {
        if (t > lastCreate) throw new RoomImportError("ORDER_NOT_NEWEST_FIRST", "TikTok returned orders out of newest-first order, so the room boundary cannot be trusted. Nothing was imported.", snapshot());
        lastCreate = t;
      }
      const inRoom = !!c && c.lineItems.some((l) => l.roomId === roomId);
      if (inRoom) {
        roomOrders.push(raw);
        stats.entered = true;
        streak = 0;
        if (t !== null) {
          stats.firstRoomOrderTime = stats.firstRoomOrderTime === null ? t : Math.min(stats.firstRoomOrderTime, t);
          stats.lastRoomOrderTime = stats.lastRoomOrderTime === null ? t : Math.max(stats.lastRoomOrderTime, t);
        }
      } else if (stats.entered) {
        streak++;
        if (streak >= limits.boundaryConfirm) {
          stats.boundary = "streak";
          return { roomOrders, stats: snapshot() };
        }
      }
    }

    if (!page.next || page.orders.length === 0) {
      if (!stats.entered) throw new RoomImportError("ROOM_NOT_FOUND", `No orders for room ${roomId} exist in TikTok's order list (${stats.inspected} inspected). Nothing was imported.`, snapshot());
      stats.boundary = "exhausted";
      return { roomOrders, stats: snapshot() };
    }
    token = page.next;
  }
}

export interface RoomImportResult {
  roomId: string;
  complete: true;
  dryRun: boolean;
  scan: ScanStats;
  scanned: {
    orders: number;
    slots: number;
    paid: number;
    unpaidCancelled: number;
    auctionNoMin: number | null;
    auctionNoMax: number | null;
    startsAtOne: boolean;
    missingNumbers: number[];
    duplicateAuctionNos: { auctionNo: string; orderIds: string[] }[];
    combinedGroups: number;
    multiOrderGroups: number;
    ordersInMultiOrderGroups: number;
    packages: number;
    exceptions: Record<string, number>;
  };
  import: ImportSummary | null;
  stored: { slotCount: number; orderCount: number; paidSlots: number; unpaidSlots: number; conflictSlots: number; auctionNoMin: number | null; auctionNoMax: number | null } | null;
  consistent: boolean | null;
}

/** Import one complete room. `deps.fetchPage` is a test seam; production uses Order Search. */
export async function importRoom(
  roomIdInput: string,
  opts: { limits?: Partial<RoomScanLimits>; dryRun?: boolean } = {},
  deps: { fetchPage?: (pageToken?: string) => Promise<OrderPage>; now?: () => number } = {}
): Promise<RoomImportResult> {
  let roomId = roomIdInput;
  let fetchPage = deps.fetchPage;
  if (!fetchPage) {
    const { accessToken, conn } = await getValidAccessToken();
    const shops = conn.shops.length ? conn.shops : (await getAuthorizedShops(accessToken)).shops;
    const shop = shops[0];
    if (!shop?.cipher) throw new Error("No authorized shop (with a shop cipher) found for this connection.");
    fetchPage = async (token) => searchPage(accessToken, shop.cipher, token).then((p) => ({ orders: p.orders, next: p.next, requestId: p.requestId }));
  }

  // "latest" = the room of the newest order that carries a room_id (the LIVE in progress).
  if (roomId === "latest") {
    const first = await fetchPage();
    const found = first.orders.map(toOrderContent).find((c) => c && c.roomId)?.roomId ?? null;
    if (!found) throw new RoomImportError("ROOM_NOT_FOUND", "No TikTok LIVE room was found among the newest orders. Nothing was imported.");
    roomId = found;
  }

  const { roomOrders, stats } = await scanForRoom({ roomId, fetchPage, limits: opts.limits, now: deps.now });

  // Describe what was scanned (same analysis as the validation sample).
  const rows = roomOrders.flatMap(projectOrder).filter((r) => r.roomId === roomId);
  const an = analyzeAuctionRows(rows, roomOrders.length);
  const room = an.rooms.find((r) => r.roomId === roomId);
  const nos = rows.map((r) => r.auctionNo).filter((n): n is number => n !== null);
  const min = nos.length ? Math.min(...nos) : null;
  const max = nos.length ? Math.max(...nos) : null;
  const have = new Set(nos);
  const missing: number[] = [];
  if (max !== null) for (let n = 1; n <= max && missing.length < 200; n++) if (!have.has(n)) missing.push(n);
  const groupOrders = new Map<string, Set<string>>();
  for (const r of rows) if (r.autoCombineGroupId) (groupOrders.get(r.autoCombineGroupId) ?? groupOrders.set(r.autoCombineGroupId, new Set()).get(r.autoCombineGroupId)!).add(r.orderId);
  const multi = [...groupOrders.values()].filter((s) => s.size > 1);
  const scanned: RoomImportResult["scanned"] = {
    orders: new Set(rows.map((r) => r.orderId)).size,
    slots: new Set(rows.map((r) => r.sellerSku)).size,
    paid: rows.filter((r) => r.paidState === "PAID").length,
    unpaidCancelled: rows.filter((r) => r.paidState !== "PAID").length,
    auctionNoMin: min,
    auctionNoMax: max,
    startsAtOne: min === 1,
    missingNumbers: missing,
    duplicateAuctionNos: room?.duplicateAuctionNos ?? [],
    combinedGroups: groupOrders.size,
    multiOrderGroups: multi.length,
    ordersInMultiOrderGroups: multi.reduce((a, s) => a + s.size, 0),
    packages: new Set(rows.map((r) => r.packageId).filter(Boolean)).size,
    exceptions: an.exceptionCounts,
  };

  if (opts.dryRun) return { roomId, complete: true, dryRun: true, scan: stats, scanned, import: null, stored: null, consistent: null };

  const summary = await importOrders(roomOrders);
  const stored = await getRoom(roomId);
  const storedView = stored
    ? { slotCount: stored.slotCount, orderCount: stored.orderCount, paidSlots: stored.paidSlots, unpaidSlots: stored.unpaidSlots, conflictSlots: stored.conflictSlots, auctionNoMin: stored.auctionNoMin, auctionNoMax: stored.auctionNoMax }
    : null;
  return {
    roomId,
    complete: true,
    dryRun: false,
    scan: stats,
    scanned,
    import: summary,
    stored: storedView,
    consistent: !!storedView && storedView.orderCount === scanned.orders && storedView.slotCount === scanned.slots,
  };
}
