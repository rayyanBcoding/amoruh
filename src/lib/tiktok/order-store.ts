import { randomBytes } from "node:crypto";
import {
  K,
  SCHEMA,
  assertNoPersonalData,
  contentHashOf,
  deriveSlot,
  toOrderContent,
  type GroupRecord,
  type MatchHealth,
  type MatchRecord,
  type OrderContent,
  type OrderRecord,
  type PackageRecord,
  type RoomRecord,
  type RoomsIndex,
  type SlotRecord,
} from "./records";
import { tiktokRedis } from "./store";

// Importer + readers for TikTok order data. Writes ONLY under amoruh:tiktok:{env}:*.
// It never touches SaleRecords, inventory, profit or the product catalog, and it
// never writes to TikTok. Safe to run repeatedly: see "duplicate prevention" below.
//
// DUPLICATE PREVENTION
//  1. Natural key: an order record's key IS its TikTok order id → re-importing overwrites
//     the same key, it can never create a second copy.
//  2. Content hash: an order is only rewritten when its projected content changed
//     (identical re-import = zero writes except the import log).
//  3. Set semantics: slot entries, group members and package members are de-duplicated and
//     RECOMPUTED from the order records, so a replay cannot add a member twice and a
//     moved order is removed from its old group/package.
//  4. Single importer: a Redis lock (NX + expiry) makes concurrent runs fail fast
//     instead of racing on the read-modify-write of slot/room/group records.
//  5. A slot is keyed by (room_id, seller_sku); the same auction number in another
//     room is a different slot and is never merged.

export class ImportInProgressError extends Error {
  constructor() {
    super("A TikTok order import is already running.");
    this.name = "ImportInProgressError";
  }
}

export interface ImportSummary {
  runId: string;
  at: string;
  received: number;
  uniqueOrders: number;
  duplicatesInBatch: number;
  skippedNoId: number;
  created: number;
  updated: number;
  unchanged: number;
  statusChanges: number;
  slotsWritten: number;
  roomsTouched: string[];
  groupsWritten: number;
  packagesWritten: number;
  unslotted: number;
  anomalyCounts: Record<string, number>;
}

const CHUNK = 100;
type R = ReturnType<typeof tiktokRedis>;

async function mgetAll<T>(r: R, keys: string[]): Promise<(T | null)[]> {
  const out: (T | null)[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    if (part.length === 0) continue;
    const res = await r.mget<(T | null)[]>(...part);
    out.push(...res.map((x) => x ?? null));
  }
  return out;
}

const slotId = (roomId: string, sku: string) => `${roomId}\u0000${sku}`;

export async function importOrders(rawOrders: unknown[], deps: { now?: () => Date } = {}): Promise<ImportSummary> {
  const r = tiktokRedis();
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const runId = `run-${now.getTime()}-${randomBytes(4).toString("hex")}`;

  const lockToken = `lock-${randomBytes(16).toString("hex")}`;
  const got = await r.set(K.importLock(), lockToken, { nx: true, ex: 120 });
  if (!got) throw new ImportInProgressError();

  try {
    // ---- 1. project (allow-list) + de-duplicate within the batch ----
    const contents = new Map<string, OrderContent>();
    let duplicatesInBatch = 0;
    let skippedNoId = 0;
    for (const raw of rawOrders) {
      const c = toOrderContent(raw);
      if (!c) {
        skippedNoId++;
        continue;
      }
      if (contents.has(c.orderId)) duplicatesInBatch++;
      contents.set(c.orderId, c);
    }
    const ids = [...contents.keys()];

    // ---- 2. diff against what we already hold ----
    const existingArr = await mgetAll<OrderRecord>(r, ids.map(K.order));
    const existing = new Map<string, OrderRecord>();
    ids.forEach((id, i) => existingArr[i] && existing.set(id, existingArr[i]!));

    const orders = new Map<string, OrderRecord>(existing); // working view of every order we know about
    const changed: OrderRecord[] = [];
    let created = 0, updated = 0, unchanged = 0, statusChanges = 0;
    for (const [id, c] of contents) {
      const hash = contentHashOf(c);
      const prev = existing.get(id);
      if (prev && prev.contentHash === hash) {
        unchanged++;
        continue;
      }
      const last = prev?.statusHistory.at(-1);
      const flipped = !last || last.status !== c.status || last.paidState !== c.paidState;
      if (prev && flipped) statusChanges++;
      const rec: OrderRecord = {
        ...c,
        contentHash: hash,
        version: (prev?.version ?? 0) + 1,
        firstSeenAt: prev?.firstSeenAt ?? nowIso,
        lastChangedAt: nowIso,
        statusHistory: flipped
          ? [...(prev?.statusHistory ?? []), { at: nowIso, status: c.status, paidState: c.paidState, updateTime: c.updateTime }].slice(-25)
          : prev!.statusHistory,
      };
      if (prev) updated++;
      else created++;
      changed.push(rec);
      orders.set(id, rec);
    }

    const writes: [string, unknown][] = [];
    const deletes: string[] = [];
    const queue = (key: string, value: unknown) => {
      assertNoPersonalData(value, key);
      writes.push([key, value]);
    };

    // ---- 3. which slots / groups / packages / rooms are affected ----
    type SlotRef = { roomId: string; sellerSku: string; auctionNo: number | null };
    const slotRefsOf = (o: OrderRecord): SlotRef[] =>
      o.orderType !== "AUCTION"
        ? []
        : o.lineItems.filter((l) => l.roomId && l.sellerSku).map((l) => ({ roomId: l.roomId!, sellerSku: l.sellerSku!, auctionNo: l.auctionNo }));

    const affectedSlots = new Map<string, SlotRef>();
    const unslottedNew = new Map<string, string>(); // orderId -> reason
    const nowSlotted = new Set<string>();
    const affectedGroups = new Set<string>();
    const affectedPackages = new Set<string>();
    for (const rec of changed) {
      const prev = existing.get(rec.orderId);
      for (const ref of [...slotRefsOf(rec), ...(prev ? slotRefsOf(prev) : [])]) affectedSlots.set(slotId(ref.roomId, ref.sellerSku), ref);
      const refs = slotRefsOf(rec);
      if (refs.length) nowSlotted.add(rec.orderId);
      else unslottedNew.set(rec.orderId, rec.orderType !== "AUCTION" ? "NON_AUCTION" : !rec.lineItems.some((l) => l.roomId) ? "NO_ROOM_ID" : "NO_SELLER_SKU");
      for (const g of [rec.autoCombineGroupId, prev?.autoCombineGroupId]) if (g) affectedGroups.add(g);
      for (const p of [...rec.packageIds, ...(prev?.packageIds ?? [])]) affectedPackages.add(p);
    }

    const slotList = [...affectedSlots.values()];
    const groupList = [...affectedGroups];
    const packageList = [...affectedPackages];
    const [slotRecs, groupRecs, packageRecs] = await Promise.all([
      mgetAll<SlotRecord>(r, slotList.map((s) => K.slot(s.roomId, s.sellerSku))),
      mgetAll<GroupRecord>(r, groupList.map(K.group)),
      mgetAll<PackageRecord>(r, packageList.map(K.pkg)),
    ]);

    // ---- 4. load every order those records mention but we don't hold yet ----
    const need = new Set<string>();
    slotRecs.forEach((s) => s?.entries.forEach((e) => need.add(e.orderId)));
    groupRecs.forEach((g) => g?.orderIds.forEach((id) => need.add(id)));
    packageRecs.forEach((p) => p?.orderIds.forEach((id) => need.add(id)));
    const missing = [...need].filter((id) => !orders.has(id));
    const loaded = await mgetAll<OrderRecord>(r, missing.map(K.order));
    missing.forEach((id, i) => loaded[i] && orders.set(id, loaded[i]!));

    // ---- 5. slots (recomputed from orders) ----
    const finalSlots = new Map<string, SlotRecord | null>();
    slotList.forEach((ref, i) => {
      const prevSlot = slotRecs[i];
      const entries = new Map<string, { orderId: string; lineItemId: string | null }>();
      for (const e of prevSlot?.entries ?? []) entries.set(`${e.orderId}\u0000${e.lineItemId}`, e);
      for (const rec of changed) {
        for (const l of rec.lineItems) if (rec.orderType === "AUCTION" && l.roomId === ref.roomId && l.sellerSku === ref.sellerSku) entries.set(`${rec.orderId}\u0000${l.lineItemId}`, { orderId: rec.orderId, lineItemId: l.lineItemId });
      }
      // keep an entry only while its order still really has that (room, sku, line item)
      const valid = [...entries.values()].filter((e) => {
        const o = orders.get(e.orderId);
        return !!o && o.orderType === "AUCTION" && o.lineItems.some((l) => l.lineItemId === e.lineItemId && l.roomId === ref.roomId && l.sellerSku === ref.sellerSku);
      });
      valid.sort((a, b) => (orders.get(a.orderId)!.createTime ?? 0) - (orders.get(b.orderId)!.createTime ?? 0) || a.orderId.localeCompare(b.orderId));
      const key = slotId(ref.roomId, ref.sellerSku);
      if (valid.length === 0) {
        finalSlots.set(key, null);
        deletes.push(K.slot(ref.roomId, ref.sellerSku));
        return;
      }
      const view = deriveSlot(valid, orders);
      const rec: SlotRecord = { schema: SCHEMA, roomId: ref.roomId, sellerSku: ref.sellerSku, auctionNo: ref.auctionNo, entries: valid, ...view, updatedAt: nowIso };
      finalSlots.set(key, rec);
      queue(K.slot(ref.roomId, ref.sellerSku), rec);
    });

    // ---- 6. rooms (+ index) ----
    const roomIds = [...new Set(slotList.map((s) => s.roomId))];
    const roomRecs = await mgetAll<RoomRecord>(r, roomIds.map(K.room));
    const idxPrev = await r.get<RoomsIndex>(K.rooms());
    const index = new Map<string, { roomId: string; firstOrderTime: number | null; lastOrderTime: number | null }>();
    for (const x of idxPrev?.rooms ?? []) index.set(x.roomId, x);
    for (let ri = 0; ri < roomIds.length; ri++) {
      const roomId = roomIds[ri];
      const prevRoom = roomRecs[ri];
      const skus = new Map<string, number | null>();
      for (const s of prevRoom?.slots ?? []) skus.set(s.sellerSku, s.auctionNo);
      for (const ref of slotList.filter((s) => s.roomId === roomId)) {
        if (finalSlots.get(slotId(roomId, ref.sellerSku)) === null) skus.delete(ref.sellerSku);
        else skus.set(ref.sellerSku, ref.auctionNo);
      }
      const others = [...skus.keys()].filter((sku) => !finalSlots.has(slotId(roomId, sku)));
      const otherRecs = await mgetAll<SlotRecord>(r, others.map((sku) => K.slot(roomId, sku)));
      const all: SlotRecord[] = [];
      for (const sku of skus.keys()) {
        const fs = finalSlots.get(slotId(roomId, sku));
        if (fs) all.push(fs);
        else {
          const o = otherRecs[others.indexOf(sku)];
          if (o) all.push(o);
        }
      }
      const nos = all.map((s) => s.auctionNo).filter((n): n is number => n !== null);
      const times = changed.filter((c) => c.roomId === roomId && c.createTime).map((c) => c.createTime!);
      const first = [prevRoom?.firstOrderTime ?? null, ...times].filter((t): t is number => t !== null);
      const last = [prevRoom?.lastOrderTime ?? null, ...times].filter((t): t is number => t !== null);
      const room: RoomRecord = {
        schema: SCHEMA,
        roomId,
        slots: all.map((s) => ({ sellerSku: s.sellerSku, auctionNo: s.auctionNo })).sort((a, b) => (a.auctionNo ?? Infinity) - (b.auctionNo ?? Infinity) || a.sellerSku.localeCompare(b.sellerSku)),
        slotCount: all.length,
        orderCount: new Set(all.flatMap((s) => s.entries.map((e) => e.orderId))).size,
        paidSlots: all.filter((s) => s.state === "PAID").length,
        unpaidSlots: all.filter((s) => s.state === "UNPAID_OPEN" || s.state === "UNPAID_CANCELLED" || s.state === "CANCELLED_AFTER_PAID").length,
        conflictSlots: all.filter((s) => s.state === "CONFLICT").length,
        auctionNoMin: nos.length ? Math.min(...nos) : null,
        auctionNoMax: nos.length ? Math.max(...nos) : null,
        firstOrderTime: first.length ? Math.min(...first) : null,
        lastOrderTime: last.length ? Math.max(...last) : null,
        updatedAt: nowIso,
      };
      queue(K.room(roomId), room);
      index.set(roomId, { roomId, firstOrderTime: room.firstOrderTime, lastOrderTime: room.lastOrderTime });
    }
    if (roomIds.length) {
      const sorted = [...index.values()].sort((a, b) => (b.lastOrderTime ?? 0) - (a.lastOrderTime ?? 0));
      queue(K.rooms(), { schema: SCHEMA, rooms: sorted } satisfies RoomsIndex);
    }

    // ---- 7. combined-package groups and packages (members recomputed from orders) ----
    let groupsWritten = 0;
    groupList.forEach((gid, i) => {
      const ids2 = new Set<string>(groupRecs[i]?.orderIds ?? []);
      for (const rec of changed) if (rec.autoCombineGroupId === gid) ids2.add(rec.orderId);
      const members = [...ids2].map((id) => orders.get(id)).filter((o): o is OrderRecord => !!o && o.autoCombineGroupId === gid);
      if (members.length === 0) return void deletes.push(K.group(gid));
      const slotKeys = new Map<string, { roomId: string; sellerSku: string }>();
      for (const o of members) for (const ref of slotRefsOf(o)) slotKeys.set(slotId(ref.roomId, ref.sellerSku), { roomId: ref.roomId, sellerSku: ref.sellerSku });
      const g: GroupRecord = {
        schema: SCHEMA,
        autoCombineGroupId: gid,
        orderIds: members.map((o) => o.orderId).sort(),
        packageIds: [...new Set(members.flatMap((o) => o.packageIds))].sort(),
        roomIds: [...new Set(members.map((o) => o.roomId).filter((x): x is string => !!x))].sort(),
        slotKeys: [...slotKeys.values()],
        trackingNumbers: [...new Set(members.flatMap((o) => o.trackingNumbers))].sort(),
        carriers: [...new Set(members.map((o) => o.carrier).filter((x): x is string => !!x))].sort(),
        updatedAt: nowIso,
      };
      queue(K.group(gid), g);
      groupsWritten++;
    });

    let packagesWritten = 0;
    packageList.forEach((pid, i) => {
      const ids2 = new Set<string>(packageRecs[i]?.orderIds ?? []);
      for (const rec of changed) if (rec.packageIds.includes(pid)) ids2.add(rec.orderId);
      const members = [...ids2].map((id) => orders.get(id)).filter((o): o is OrderRecord => !!o && o.packageIds.includes(pid));
      if (members.length === 0) return void deletes.push(K.pkg(pid));
      const lines = members.flatMap((o) => o.lineItems.filter((l) => l.packageId === pid));
      const p: PackageRecord = {
        schema: SCHEMA,
        packageId: pid,
        autoCombineGroupId: members.find((o) => o.autoCombineGroupId)?.autoCombineGroupId ?? null,
        orderIds: members.map((o) => o.orderId).sort(),
        lineItemIds: [...new Set(lines.map((l) => l.lineItemId).filter((x): x is string => !!x))].sort(),
        trackingNumbers: [...new Set(members.flatMap((o) => o.trackingNumbers))].sort(),
        carrier: members.find((o) => o.carrier)?.carrier ?? null,
        shippingType: members.find((o) => o.shippingType)?.shippingType ?? null,
        updatedAt: nowIso,
      };
      queue(K.pkg(pid), p);
      packagesWritten++;
    });

    // ---- 8. orders, unslotted list, import log ----
    for (const rec of changed) queue(K.order(rec.orderId), rec);

    if (unslottedNew.size || nowSlotted.size) {
      const prevU = await r.get<{ entries: { orderId: string; reason: string; at: string }[] }>(K.unslotted());
      const kept = (prevU?.entries ?? []).filter((e) => !nowSlotted.has(e.orderId) && !unslottedNew.has(e.orderId));
      const added = [...unslottedNew].map(([orderId, reason]) => ({ orderId, reason, at: nowIso }));
      queue(K.unslotted(), { schema: SCHEMA, entries: [...kept, ...added].slice(-500) });
    }

    const anomalyCounts: Record<string, number> = {};
    for (const rec of changed) for (const a of rec.anomalies) anomalyCounts[a.split(":")[0]] = (anomalyCounts[a.split(":")[0]] ?? 0) + 1;

    const summary: ImportSummary = {
      runId,
      at: nowIso,
      received: rawOrders.length,
      uniqueOrders: contents.size,
      duplicatesInBatch,
      skippedNoId,
      created,
      updated,
      unchanged,
      statusChanges,
      slotsWritten: [...finalSlots.values()].filter(Boolean).length,
      roomsTouched: roomIds,
      groupsWritten,
      packagesWritten,
      unslotted: unslottedNew.size,
      anomalyCounts,
    };
    queue(K.importLog(runId), summary);
    const prevImports = await r.get<{ runIds: string[] }>(K.imports());
    queue(K.imports(), { schema: SCHEMA, runIds: [runId, ...(prevImports?.runIds ?? [])].slice(0, 50) });

    // ---- 9. write ----
    const p = r.pipeline();
    for (const [k, v] of writes) p.set(k, v);
    for (const k of deletes) p.del(k);
    await p.exec();
    return summary;
  } finally {
    const cur = await r.get<string>(K.importLock()).catch(() => null);
    if (cur === lockToken) await r.del(K.importLock()).catch(() => undefined);
  }
}

// ---------------- readers ----------------

export const getOrder = (orderId: string) => tiktokRedis().get<OrderRecord>(K.order(orderId));
export const getSlot = (roomId: string, sellerSku: string) => tiktokRedis().get<SlotRecord>(K.slot(roomId, sellerSku));
export const getRoom = (roomId: string) => tiktokRedis().get<RoomRecord>(K.room(roomId));
export const getRoomsIndex = () => tiktokRedis().get<RoomsIndex>(K.rooms());
export const getGroup = (groupId: string) => tiktokRedis().get<GroupRecord>(K.group(groupId));
export const getPackage = (packageId: string) => tiktokRedis().get<PackageRecord>(K.pkg(packageId));

export function matchHealthOf(match: MatchRecord | null, slot: SlotRecord | null): MatchHealth | null {
  if (!match || match.state === "voided") return null;
  if (!slot) return "STALE_SLOT_MISSING";
  if (!slot.matchable) return "STALE_ORDER_NOT_PAID";
  if (slot.activeEntry?.orderId !== match.orderId || slot.activeEntry?.lineItemId !== match.lineItemId) return "STALE_ORDER_CHANGED";
  return "OK";
}

export interface RoomViewRow {
  sellerSku: string;
  auctionNo: number | null;
  slotState: SlotRecord["state"];
  matchable: boolean;
  orderIds: string[];
  activeOrderId: string | null;
  activeLineItemId: string | null;
  salePrice: string | null;
  currency: string | null;
  orderStatus: string | null;
  paidTime: number | null;
  cancelReason: string | null;
  packageId: string | null;
  autoCombineGroupId: string | null;
  ordersInGroup: number;
  carrier: string | null;
  hasTracking: boolean;
  trackingLast4: string | null;
  match: { state: MatchRecord["state"]; productId: string; version: number; health: MatchHealth | null } | null;
}

/** Everything the future matching screen needs for one room, joined. No personal data. */
export async function getRoomView(roomId: string): Promise<{ room: RoomRecord; rows: RoomViewRow[] } | null> {
  const r = tiktokRedis();
  const room = await getRoom(roomId);
  if (!room) return null;
  const slots = (await mgetAll<SlotRecord>(r, room.slots.map((s) => K.slot(roomId, s.sellerSku)))).filter((s): s is SlotRecord => !!s);
  const matches = await mgetAll<MatchRecord>(r, slots.map((s) => K.match(roomId, s.sellerSku)));
  const orderIds = [...new Set(slots.flatMap((s) => s.entries.map((e) => e.orderId)))];
  const orders = new Map<string, OrderRecord>();
  (await mgetAll<OrderRecord>(r, orderIds.map(K.order))).forEach((o) => o && orders.set(o.orderId, o));
  const groupIds = [...new Set([...orders.values()].map((o) => o.autoCombineGroupId).filter((x): x is string => !!x))];
  const groups = new Map<string, GroupRecord>();
  (await mgetAll<GroupRecord>(r, groupIds.map(K.group))).forEach((g) => g && groups.set(g.autoCombineGroupId, g));

  const rows: RoomViewRow[] = slots.map((s, i) => {
    const o = orders.get((s.activeEntry ?? s.entries[s.entries.length - 1])?.orderId ?? "");
    const m = matches[i];
    const tn = o?.trackingNumbers[0] ?? null;
    return {
      sellerSku: s.sellerSku,
      auctionNo: s.auctionNo,
      slotState: s.state,
      matchable: s.matchable,
      orderIds: s.entries.map((e) => e.orderId),
      activeOrderId: s.activeEntry?.orderId ?? null,
      activeLineItemId: s.activeEntry?.lineItemId ?? null,
      salePrice: s.salePrice,
      currency: s.currency,
      orderStatus: o?.status ?? null,
      paidTime: o?.paidTime ?? null,
      cancelReason: o?.cancelReason ?? null,
      packageId: o?.packageIds[0] ?? null,
      autoCombineGroupId: o?.autoCombineGroupId ?? null,
      ordersInGroup: o?.autoCombineGroupId ? groups.get(o.autoCombineGroupId)?.orderIds.length ?? 1 : 1,
      carrier: o?.carrier ?? null,
      hasTracking: !!tn,
      trackingLast4: tn ? tn.slice(-4) : null,
      match: m && m.state !== "voided" ? { state: m.state, productId: m.productId, version: m.version, health: matchHealthOf(m, s) } : null,
    };
  });
  rows.sort((a, b) => (a.auctionNo ?? Infinity) - (b.auctionNo ?? Infinity) || a.sellerSku.localeCompare(b.sellerSku));
  return { room, rows };
}
