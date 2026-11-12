import { MatchError, voidMatch, selectMatch, getMatch } from "./matches";
import { getRoom, getRoomsIndex, matchHealthOf } from "./order-store";
import { K, type MatchHealth, type MatchRecord, type RoomRecord, type SlotRecord, type SlotState } from "./records";
import { tiktokRedis } from "./store";

// Read model + match writes for the Go Live TikTok panel.
// Reads ONLY our stored TikTok records (never calls TikTok). Match writes go ONLY to
// the TikTok-side match record (room_id, seller_sku) → AMORUH productId.
// It never creates a SaleRecord and never changes inventory, cost or profit.

export interface PanelRoom {
  roomId: string;
  firstOrderTime: number | null;
  lastOrderTime: number | null;
  slotCount: number;
  paidSlots: number;
  unpaidSlots: number;
  auctionNoMax: number | null;
  updatedAt: string;
}

export interface PanelRow {
  sellerSku: string;
  auctionNo: number | null;
  state: SlotState;
  matchable: boolean;
  salePrice: string | null;
  currency: string | null;
  orderId: string | null;
  match: { productId: string; version: number; health: MatchHealth | null } | null;
}

export interface PanelData {
  rooms: PanelRoom[];
  roomId: string | null;
  roomUpdatedAt: string | null;
  rows: PanelRow[];
}

const MAX_ROOMS = 15;

const toPanelRoom = (r: RoomRecord): PanelRoom => ({
  roomId: r.roomId,
  firstOrderTime: r.firstOrderTime,
  lastOrderTime: r.lastOrderTime,
  slotCount: r.slotCount,
  paidSlots: r.paidSlots,
  unpaidSlots: r.unpaidSlots,
  auctionNoMax: r.auctionNoMax,
  updatedAt: r.updatedAt,
});

/** `roomId` = a specific room, or "latest"/null = the newest stored room. */
export async function getPanel(roomId: string | null): Promise<PanelData> {
  const r = tiktokRedis();
  const index = await getRoomsIndex();
  const ids = (index?.rooms ?? []).slice(0, MAX_ROOMS).map((x) => x.roomId);
  const recs = ids.length ? ((await r.mget<(RoomRecord | null)[]>(...ids.map(K.room))) as (RoomRecord | null)[]) : [];
  const rooms = recs.filter((x): x is RoomRecord => !!x).map(toPanelRoom);
  const wanted = !roomId || roomId === "latest" ? rooms[0]?.roomId ?? null : roomId;
  if (!wanted) return { rooms, roomId: null, roomUpdatedAt: null, rows: [] };
  const room = await getRoom(wanted);
  if (!room) return { rooms, roomId: wanted, roomUpdatedAt: null, rows: [] };

  const skus = room.slots.map((s) => s.sellerSku);
  const slots = skus.length ? ((await r.mget<(SlotRecord | null)[]>(...skus.map((s) => K.slot(wanted, s)))) as (SlotRecord | null)[]) : [];
  const matches = skus.length ? ((await r.mget<(MatchRecord | null)[]>(...skus.map((s) => K.match(wanted, s)))) as (MatchRecord | null)[]) : [];
  const rows: PanelRow[] = [];
  slots.forEach((s, i) => {
    if (!s) return;
    const m = matches[i];
    const live = m && m.state !== "voided" ? m : null;
    rows.push({
      sellerSku: s.sellerSku,
      auctionNo: s.auctionNo,
      state: s.state,
      matchable: s.matchable,
      salePrice: s.salePrice,
      currency: s.currency,
      orderId: s.activeEntry?.orderId ?? s.entries[s.entries.length - 1]?.orderId ?? null,
      match: live ? { productId: live.productId, version: live.version, health: matchHealthOf(live, s) } : null,
    });
  });
  rows.sort((a, b) => (a.auctionNo ?? Infinity) - (b.auctionNo ?? Infinity) || a.sellerSku.localeCompare(b.sellerSku));
  return { rooms, roomId: wanted, roomUpdatedAt: room.updatedAt, rows };
}

/** Choose (or clear) the AMORUH product for one auction. Only the TikTok-side match record is written. */
export async function setPanelMatch(
  args: { roomId: string; sellerSku: string; productId: string | null; selectedBy?: string },
  deps: { productExists?: (productId: string) => Promise<boolean> } = {}
): Promise<{ match: { productId: string; version: number } | null }> {
  if (args.productId === null) {
    const prev = await getMatch(args.roomId, args.sellerSku);
    if (!prev || prev.state === "voided") return { match: null };
    await voidMatch({ roomId: args.roomId, sellerSku: args.sellerSku, reason: "cleared in Go Live" });
    return { match: null };
  }
  if (deps.productExists && !(await deps.productExists(args.productId))) throw new MatchError("BAD_PRODUCT_ID", "That product no longer exists.");
  const rec = await selectMatch({ roomId: args.roomId, sellerSku: args.sellerSku, productId: args.productId, selectedBy: args.selectedBy ?? "go-live" });
  return { match: { productId: rec.productId, version: rec.version } };
}
