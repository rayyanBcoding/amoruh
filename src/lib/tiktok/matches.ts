import { getRoom, getSlot, matchHealthOf } from "./order-store";
import { K, SCHEMA, assertNoPersonalData, type MatchRecord, type RoomSessionLink, type SessionLink } from "./records";
import { tiktokRedis } from "./store";

// Explicit match records ("auction slot → AMORUH product") and optional
// room ↔ AMORUH-live-session links.
//
// HARD LIMITS of this module (Milestone 2, data layer only):
//  * It never creates a SaleRecord, never touches inventory / cost / profit, never
//    modifies a TikTok order record and never writes to TikTok.
//  * `confirmed`, `confirmedAt` and `saleRecordId` exist only as reserved fields for the
//    later milestone; nothing here ever sets them.
//  * Rooms are NEVER merged. Linking rooms to a session is metadata only — every slot
//    stays identified by (room_id, seller_sku).

export type MatchErrorCode =
  | "SLOT_NOT_FOUND"
  | "SLOT_NOT_MATCHABLE"
  | "SLOT_CONFLICT"
  | "BAD_PRODUCT_ID"
  | "MATCH_CONFIRMED_LOCKED"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "ROOM_NOT_FOUND"
  | "ROOM_ALREADY_LINKED";

export class MatchError extends Error {
  constructor(public code: MatchErrorCode, message: string) {
    super(message);
    this.name = "MatchError";
  }
}

export const getMatch = (roomId: string, sellerSku: string) => tiktokRedis().get<MatchRecord>(K.match(roomId, sellerSku));

/** Pick (or change) the AMORUH product for one auction slot. Only a slot with exactly one PAID order can be matched. */
export async function selectMatch(
  args: { roomId: string; sellerSku: string; productId: string; selectedBy?: string; expectedVersion?: number },
  deps: { now?: () => Date } = {}
): Promise<MatchRecord> {
  const { roomId, sellerSku } = args;
  const productId = typeof args.productId === "string" ? args.productId.trim() : "";
  if (!productId) throw new MatchError("BAD_PRODUCT_ID", "A product id is required.");
  const slot = await getSlot(roomId, sellerSku);
  if (!slot) throw new MatchError("SLOT_NOT_FOUND", `No TikTok auction slot for room ${roomId} #${sellerSku}.`);
  if (slot.state === "CONFLICT") throw new MatchError("SLOT_CONFLICT", `Auction #${sellerSku} has more than one paid TikTok order in this room; resolve it before matching.`);
  if (!slot.matchable || !slot.activeEntry) throw new MatchError("SLOT_NOT_MATCHABLE", `Auction #${sellerSku} is ${slot.state} on TikTok and cannot be matched to a sale.`);

  const prev = await getMatch(roomId, sellerSku);
  if (prev?.state === "confirmed") throw new MatchError("MATCH_CONFIRMED_LOCKED", "This slot's match is already confirmed.");
  if (args.expectedVersion !== undefined && (prev?.version ?? 0) !== args.expectedVersion) throw new MatchError("VERSION_CONFLICT", "This match changed since you loaded it.");

  const now = (deps.now ?? (() => new Date()))().toISOString();
  const rec: MatchRecord = {
    schema: SCHEMA,
    roomId,
    sellerSku,
    auctionNo: slot.auctionNo,
    orderId: slot.activeEntry.orderId,
    lineItemId: slot.activeEntry.lineItemId,
    productId,
    state: "selected",
    tiktokSalePrice: slot.salePrice,
    currency: slot.currency,
    tiktokPaidState: "PAID",
    selectedAt: now,
    selectedBy: args.selectedBy ?? null,
    confirmedAt: null,
    saleRecordId: null,
    voidedAt: null,
    voidReason: null,
    version: (prev?.version ?? 0) + 1,
  };
  assertNoPersonalData(rec, "match");
  await tiktokRedis().set(K.match(roomId, sellerSku), rec);
  return rec;
}

/** Clear a selection. The record is kept (state "voided") for audit; it never deletes TikTok data. */
export async function voidMatch(args: { roomId: string; sellerSku: string; reason?: string }, deps: { now?: () => Date } = {}): Promise<MatchRecord> {
  const prev = await getMatch(args.roomId, args.sellerSku);
  if (!prev) throw new MatchError("NOT_FOUND", "No match to clear.");
  if (prev.state === "confirmed") throw new MatchError("MATCH_CONFIRMED_LOCKED", "A confirmed match cannot be cleared here.");
  const rec: MatchRecord = { ...prev, state: "voided", voidedAt: (deps.now ?? (() => new Date()))().toISOString(), voidReason: args.reason ?? null, version: prev.version + 1 };
  await tiktokRedis().set(K.match(args.roomId, args.sellerSku), rec);
  return rec;
}

/** Is a stored match still consistent with what TikTok currently says? */
export async function matchHealth(roomId: string, sellerSku: string) {
  return matchHealthOf(await getMatch(roomId, sellerSku), await getSlot(roomId, sellerSku));
}

// ---------- optional association of rooms with ONE AMORUH live session ----------

export const getSessionLink = (sessionId: string) => tiktokRedis().get<SessionLink>(K.sessionLink(sessionId));
export const getRoomSession = (roomId: string) => tiktokRedis().get<RoomSessionLink>(K.roomSession(roomId));

/** Explicitly attach a TikTok room to an AMORUH live session. A session may hold several
 *  rooms (a LIVE that was interrupted and restarted); a room belongs to at most one session.
 *  Never automatic, and it never changes any slot's identity. */
export async function linkRoomToSession(sessionId: string, roomId: string, deps: { now?: () => Date } = {}): Promise<SessionLink> {
  const r = tiktokRedis();
  if (!sessionId.trim()) throw new MatchError("NOT_FOUND", "A session id is required.");
  if (!(await getRoom(roomId))) throw new MatchError("ROOM_NOT_FOUND", `Unknown TikTok room ${roomId}.`);
  const existing = await getRoomSession(roomId);
  if (existing && existing.sessionId !== sessionId) throw new MatchError("ROOM_ALREADY_LINKED", `Room ${roomId} is already linked to session ${existing.sessionId}.`);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const link = (await getSessionLink(sessionId)) ?? { schema: SCHEMA, sessionId, roomIds: [], updatedAt: now };
  const next: SessionLink = { ...link, roomIds: [...new Set([...link.roomIds, roomId])], updatedAt: now };
  await r.set(K.sessionLink(sessionId), next);
  await r.set(K.roomSession(roomId), { schema: SCHEMA, roomId, sessionId, linkedAt: existing?.linkedAt ?? now } satisfies RoomSessionLink);
  return next;
}

export async function unlinkRoom(roomId: string, deps: { now?: () => Date } = {}): Promise<void> {
  const r = tiktokRedis();
  const existing = await getRoomSession(roomId);
  if (!existing) return;
  const link = await getSessionLink(existing.sessionId);
  if (link) await r.set(K.sessionLink(existing.sessionId), { ...link, roomIds: link.roomIds.filter((x) => x !== roomId), updatedAt: (deps.now ?? (() => new Date()))().toISOString() });
  await r.del(K.roomSession(roomId));
}
