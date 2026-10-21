import { redis, KEYS as CoreKeys } from "./kv";
import { getProducts, getState, getVersion, makeSaleFromProduct } from "./db";
import { checkIdempotencyFast, idempotencyKeyOf } from "./atomic-write";
import { getLotsWithRemaining, getAllInventoryTransactions, newId, KEYS as IntakeKeys } from "./intake-db";
import type { InventoryLotWithRemaining, InventoryTransaction } from "./intake-types";
import type { LiveState } from "./types";
import type { LivePresentation } from "./live-types";

// ---------------------------------------------------------------------
// Durable, scalable sale history + the atomic, optimistic-concurrency-
// protected sale write paths.
//
// Storage: one small Redis key per SaleRecord (never a growing array
// rewritten on every sale), plus two sorted-set indexes (per-product,
// global) for audit/browsing, plus one small per-product aggregate key
// so Average Sale Price is an O(1) read, not a scan over every historical
// sale. SaleRecords are the permanent source of truth; the aggregate is
// written in the same atomic operation as everything else below, so it
// can never drift from the records that back it.
//
// Two entry points now share this file's lot/aggregate/version machinery:
//   - markProductSold()  — the original, legacy path (always qty 1, no
//     Live Session). Untouched behavior; still what the plain Inventory
//     "Mark Sold" action uses.
//   - recordSale()        — Go Live's Record Sale: arbitrary quantity,
//     spans multiple lots if needed, tied to a LiveSession + creates a
//     LivePresentation, and derives its winning-bid TOTAL vs. per-unit
//     price as two distinct metrics (see SalesAggregate below).
// Both write through the exact same version-guarded compare-and-swap
// pattern; recordNoSale/cancelSale/correctSalePrice (see below) each get
// their own equivalently-guarded script sized to what they touch — see
// the approved plan (linear-drifting-eclipse.md) for the full rationale.
// ---------------------------------------------------------------------

export class SalesError extends Error {
  status: number;
  /** Machine-readable reason the UI can act on (e.g. offer "Sell anyway"). */
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "SalesError";
    this.status = status;
    this.code = code;
  }
}

export type SaleRecordStatus = "completed" | "canceled" | "refunded";

export interface SaleRecord {
  id: string;
  productId: string;
  sku: string;
  /** Effective price — for quantity 1 this is simply the sale price; for
   *  a multi-unit Go Live auction this is the TOTAL winning bid across
   *  every unit in `quantity`, never a per-unit price. Post-correction,
   *  this is the corrected value; see `originalPrice` for the audit
   *  trail. */
  price: number;
  quantity: number;
  soldAt: string;
  status: SaleRecordStatus;
  /** First lot touched — kept for simple display/back-compat. The full
   *  per-lot breakdown for a multi-lot sale lives in InventoryTransaction
   *  (filter by `saleId`), never reconstructed from this field alone. */
  lotId: string | null;
  /** Quantity-weighted average landed cost of the lot(s) actually
   *  consumed by this sale — null when the product had no lot data at
   *  all (legacy/manually-added product; sale still succeeds, just with
   *  no cost basis to record). Frozen at time of sale; never recomputed
   *  when later inventory arrives at a different cost. */
  landedCostAtSale: number | null;
  liveSessionId: string | null;
  presentationId: string | null;
  /** CAS guard for cancelSale/correctSalePrice — see finding #14 of the
   *  approved plan. Starts at 0; every correction or cancellation bumps
   *  it. Absent (undefined) on records written before this field existed
   *  reads as 0 — see readSaleVersion(). */
  saleVersion: number;
  /** Set only on the FIRST-ever price correction; never overwritten by a
   *  later one, so audit always shows the true original bid. */
  originalPrice: number | null;
  correctedAt: string | null;
  correctedBy: string | null;
  canceledAt: string | null;
  canceledBy: string | null;
  /** Per-LiveSession order number: 1, 2, 3… in exact submission order, assigned
   *  atomically inside RECORD_LIVE_SALE_SCRIPT (INCR on the session's own
   *  sequence key). Never reassigned or reused — a canceled order keeps its
   *  number, and edit/restore never change it. Null/absent on sales recorded
   *  before the Live Order Ledger existed (and on legacy non-Live sales);
   *  those are never numbered silently on read. */
  liveOrderNumber?: number | null;
  /** Set by restoreSale; the cancel fields above keep describing the most
   *  recent cancellation (the full history is the sale's audit list). */
  restoredAt?: string | null;
  restoredBy?: string | null;
  /** Units of this sale the system had no stock record for when it was recorded
   *  (the host explicitly chose "Sell anyway"). Null/absent for normal sales. */
  oversoldQuantity?: number | null;
}

export type SaleAuditAction =
  | "created"
  | "price_changed"
  | "quantity_changed"
  | "product_changed"
  | "canceled"
  | "restored";

/** One immutable entry of a sale's append-only audit list
 *  (`amoruh:live:sale_audit:{saleId}`, bounded to the latest 200 events). */
export interface SaleAuditEvent {
  id: string;
  saleId: string;
  liveOrderNumber: number | null;
  action: SaleAuditAction;
  at: string;
  operator: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Profit and margin are always DERIVED from the sale's own fields — never
 *  stored — so there is one calculation everywhere (session stats, ledger,
 *  order detail). `landedCostAtSale` is per unit and frozen at sale time. */
export function deriveSaleFinancials(sale: Pick<SaleRecord, "price" | "quantity" | "landedCostAtSale">): {
  unitCost: number | null;
  totalCost: number | null;
  profit: number | null;
  margin: number | null;
} {
  const unitCost = sale.landedCostAtSale ?? null;
  if (unitCost === null) return { unitCost: null, totalCost: null, profit: null, margin: null };
  const totalCost = Math.round(unitCost * (sale.quantity ?? 1) * 100) / 100;
  const profit = Math.round((sale.price - totalCost) * 100) / 100;
  return { unitCost, totalCost, profit, margin: sale.price > 0 ? profit / sale.price : null };
}

interface SalesAggregate {
  /** # of successful sale EVENTS (auctions) — NOT units. */
  completedSaleCount: number;
  /** Total units sold across those events. Equal to completedSaleCount
   *  for every sale that was ever quantity 1 (the entire pre-Go-Live
   *  history) — only diverges once a qty>1 auction exists. */
  completedUnitsSold: number;
  /** Total effective ($) revenue — reflects corrections, excludes
   *  canceled sales' contribution. */
  completedSalesRevenue: number;
}

const ZERO_AGGREGATE: SalesAggregate = { completedSaleCount: 0, completedUnitsSold: 0, completedSalesRevenue: 0 };

function saleKey(saleId: string): string {
  return `amoruh:sales:${saleId}`;
}
/** Exported so live-db.ts can batch-read sales (MGET) without a cycle. */
export const saleKeyOf = saleKey;
function aggregateKey(productId: string): string {
  return `amoruh:sales:aggregate:${productId}`;
}
function byProductZsetKey(productId: string): string {
  return `amoruh:sales:by_product:${productId}`;
}
const ALL_SALES_ZSET_KEY = "amoruh:sales:all";

/** Per-session order sequence — INCR'd inside the sale-creating Lua script. */
export function sessionOrderSeqKey(sessionId: string): string {
  return `amoruh:live:session_order_seq:${sessionId}`;
}
/** Append-only audit list for one sale. */
export function saleAuditKey(saleId: string): string {
  return `amoruh:live:sale_audit:${saleId}`;
}
const SALE_AUDIT_MAX_EVENTS = 200;

// Exported so live-db.ts (session stats, recent-sales-for-session) can
// resolve the same keys without a circular import — live-db.ts depends on
// this file (for recordSale/recordNoSale/cancelSale/correctSalePrice),
// never the other way around.
export function presentationKey(presentationId: string): string {
  return `amoruh:live:presentation:${presentationId}`;
}
export function presentationsBySessionZsetKey(sessionId: string): string {
  return `amoruh:live:presentations_by_session:${sessionId}`;
}

/** Backward-compat read: an aggregate written before `completedUnitsSold`
 *  existed defaults it to `completedSaleCount` — correct for every
 *  pre-existing record, since every sale before Go Live was quantity 1. */
async function getSalesAggregate(productId: string): Promise<SalesAggregate> {
  const raw = await redis.get<Partial<SalesAggregate>>(aggregateKey(productId));
  if (!raw) return ZERO_AGGREGATE;
  const completedSaleCount = raw.completedSaleCount ?? 0;
  return {
    completedSaleCount,
    completedUnitsSold: raw.completedUnitsSold ?? completedSaleCount,
    completedSalesRevenue: raw.completedSalesRevenue ?? 0,
  };
}

/** Average Selling Price PER UNIT — completedSalesRevenue /
 *  completedUnitsSold. This is the metric Inventory's product view and
 *  Dashboard's future "Average Selling Price" stat both use; it is
 *  deliberately NOT the same as Average Auction (see
 *  computeAverageAuction) once any sale has quantity > 1. */
export async function computeAverageSalePrice(
  productId: string
): Promise<{ averageSalePrice: number | null; saleCount: number }> {
  const agg = await getSalesAggregate(productId);
  if (agg.completedUnitsSold === 0) return { averageSalePrice: null, saleCount: agg.completedSaleCount };
  return { averageSalePrice: agg.completedSalesRevenue / agg.completedUnitsSold, saleCount: agg.completedSaleCount };
}

/** Average Auction / Average Winning Bid — completedSalesRevenue /
 *  completedSaleCount (# of auctions, not units). Identical to
 *  computeAverageSalePrice for an all-quantity-1 history; diverges once a
 *  multi-unit auction exists. Used by Go Live's AVG AUCTION stat. */
export async function computeAverageAuction(
  productId: string
): Promise<{ averageAuction: number | null; auctionCount: number }> {
  const agg = await getSalesAggregate(productId);
  if (agg.completedSaleCount === 0) return { averageAuction: null, auctionCount: 0 };
  return { averageAuction: agg.completedSalesRevenue / agg.completedSaleCount, auctionCount: agg.completedSaleCount };
}

/** Pages the per-product sorted-set index, newest first — the audit
 *  trail view. Never loads sales outside the requested page. */
export async function getSaleRecordsForProduct(productId: string, limit = 50): Promise<SaleRecord[]> {
  const ids = (await redis.zrange(byProductZsetKey(productId), 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => redis.get<SaleRecord>(saleKey(id))));
  return records.filter((r): r is SaleRecord => r !== null).map(normalizeSaleRecord);
}

export async function getSaleRecordById(saleId: string): Promise<SaleRecord | null> {
  const raw = await redis.get<SaleRecord>(saleKey(saleId));
  return raw ? normalizeSaleRecord(raw) : null;
}

/** Fills in defaults for fields that didn't exist on a SaleRecord written
 *  before Go Live — never trust `undefined` where the type says
 *  `number`/`null`. */
export function normalizeSaleRecord(raw: SaleRecord): SaleRecord {
  return {
    ...raw,
    quantity: raw.quantity ?? 1,
    liveSessionId: raw.liveSessionId ?? null,
    presentationId: raw.presentationId ?? null,
    saleVersion: raw.saleVersion ?? 0,
    originalPrice: raw.originalPrice ?? null,
    correctedAt: raw.correctedAt ?? null,
    correctedBy: raw.correctedBy ?? null,
    canceledAt: raw.canceledAt ?? null,
    canceledBy: raw.canceledBy ?? null,
    liveOrderNumber: raw.liveOrderNumber ?? null,
    restoredAt: raw.restoredAt ?? null,
    restoredBy: raw.restoredBy ?? null,
    oversoldQuantity: raw.oversoldQuantity ?? null,
  };
}

export async function getSaleAudit(saleId: string): Promise<SaleAuditEvent[]> {
  return (await redis.lrange<SaleAuditEvent>(saleAuditKey(saleId), 0, -1)) ?? [];
}

/** The most recent COMPLETED (non-canceled) sale for a product — Go
 *  Live's LAST SOLD stat. Checked on the effective (post-correction)
 *  price, on the same auction-total basis as Average Auction. Scans a
 *  small bounded window of recent records (a canceled sale doesn't count,
 *  but is rare enough that a short window always finds the real answer
 *  without a full history scan). */
export async function getLastSoldPrice(productId: string): Promise<number | null> {
  const recent = await getSaleRecordsForProduct(productId, 10);
  const lastCompleted = recent.find((s) => s.status === "completed");
  return lastCompleted?.price ?? null;
}

type LotConsumptionPlan = { lotId: string; poId: string | null; poLineId: string | null; qty: number; unitLandedCost: number }[];

/** Oldest-lot-first consumption plan for `quantity` units.
 *  - No lots exist at all for this product (legacy/manually-added
 *    product, no PO history) → `{ plan: [], weightedLandedCost: null }`;
 *    caller falls back to checking Product.inventory directly, exactly
 *    like the pre-Go-Live single-lot path did for a null lot.
 *  - Lots exist but don't cover `quantity` → `"insufficient"`.
 *  - Otherwise the ordered per-lot plan + the quantity-weighted average
 *    landed cost across only the units actually consumed. */
async function findLotsToConsume(
  productId: string,
  quantity: number
): Promise<{ plan: LotConsumptionPlan; weightedLandedCost: number | null } | "insufficient"> {
  const lots = await getLotsWithRemaining(productId); // already oldest-first
  if (lots.length === 0) {
    return { plan: [], weightedLandedCost: null };
  }
  let need = quantity;
  const plan: LotConsumptionPlan = [];
  for (const lot of lots) {
    if (need <= 0) break;
    if (lot.remaining <= 0) continue;
    const take = Math.min(lot.remaining, need);
    plan.push({ lotId: lot.id, poId: lot.poId, poLineId: lot.poLineId, qty: take, unitLandedCost: lot.cost.landed });
    need -= take;
  }
  if (need > 0) return "insufficient";
  const totalQty = plan.reduce((s, p) => s + p.qty, 0);
  const weightedLandedCost =
    totalQty > 0 ? plan.reduce((s, p) => s + p.qty * p.unitLandedCost, 0) / totalQty : null;
  return { plan, weightedLandedCost };
}

/** "Sell anyway": consume whatever the lots still hold (oldest first), up to
 *  `quantity`, without refusing when stock is short. The units the system has
 *  no record for are reported as oversold. Cost basis: the weighted cost of the
 *  lots actually consumed; when no lot has stock left, the cost of the product's
 *  most recent lot; null when it has no lot data at all (same as any such sale). */
async function planConsumeUpTo(
  productId: string,
  quantity: number
): Promise<{ plan: LotConsumptionPlan; weightedLandedCost: number | null; coveredFromLots: number }> {
  const lots = await getLotsWithRemaining(productId); // oldest-first
  let need = quantity;
  const plan: LotConsumptionPlan = [];
  for (const lot of lots) {
    if (need <= 0) break;
    if (lot.remaining <= 0) continue;
    const take = Math.min(lot.remaining, need);
    plan.push({ lotId: lot.id, poId: lot.poId, poLineId: lot.poLineId, qty: take, unitLandedCost: lot.cost.landed });
    need -= take;
  }
  const covered = plan.reduce((sum, p) => sum + p.qty, 0);
  if (covered > 0) {
    return { plan, weightedLandedCost: plan.reduce((sum, p) => sum + p.qty * p.unitLandedCost, 0) / covered, coveredFromLots: covered };
  }
  const latest = lots.length > 0 ? lots[lots.length - 1] : null;
  return { plan, weightedLandedCost: latest ? latest.cost.landed : null, coveredFromLots: 0 };
}

/** Legacy single-unit lookup, kept only for `markProductSold` below —
 *  identical selection rule to `findLotsToConsume(productId, 1)`, but
 *  returns the bare lot (no plan wrapper) since the caller's script shape
 *  predates the generalized multi-lot flow. */
async function findOldestLotWithStock(productId: string): Promise<InventoryLotWithRemaining | null> {
  const lots = await getLotsWithRemaining(productId);
  return lots.find((l) => l.remaining > 0) ?? null;
}

const MAX_RECENT_SALES = 25;
const MAX_CONFLICT_RETRIES = 3;

// ---------------------------------------------------------------------
// markProductSold — legacy path, quantity always 1, no Live Session.
// Untouched behavior from before Go Live; only the SaleRecord/aggregate
// SHAPES grew (backward-compatible additions), not this script's logic.
// ---------------------------------------------------------------------

// KEYS[1]  idempotency key
// KEYS[2]  product version key
// KEYS[3]  products key
// KEYS[4]  state key
// KEYS[5]  inventory_transactions key (touched only if ARGV[10] == "1")
// KEYS[6]  sale record key
// KEYS[7]  per-product aggregate key
// KEYS[8]  global version key
// KEYS[9]  per-product sales zset key
// KEYS[10] global sales zset key
//
// ARGV[1]  idempotency marker (saleId)
// ARGV[2]  expected product version (string)
// ARGV[3]  new product version (string)
// ARGV[4]  new products array (JSON)
// ARGV[5]  new state (JSON)
// ARGV[6]  new inventory_transactions array (JSON) — ignored if ARGV[10] == "0"
// ARGV[7]  new sale record (JSON)
// ARGV[8]  new aggregate (JSON)
// ARGV[9]  new global version (string number)
// ARGV[10] "1" if a lot was consumed (touch KEYS[5]), else "0"
// ARGV[11] score for zadd (timestamp ms, string)
// ARGV[12] member for zadd (saleId)
const MARK_SOLD_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end

local currentVersion = redis.call('GET', KEYS[2])
if not currentVersion then
  currentVersion = '0'
end
if currentVersion ~= ARGV[2] then
  return 'CONFLICT'
end

redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[4], ARGV[5])
if ARGV[10] == '1' then
  redis.call('SET', KEYS[5], ARGV[6])
end
redis.call('SET', KEYS[6], ARGV[7])
redis.call('SET', KEYS[7], ARGV[8])
redis.call('SET', KEYS[8], ARGV[9])
redis.call('ZADD', KEYS[9], ARGV[11], ARGV[12])
redis.call('ZADD', KEYS[10], ARGV[11], ARGV[12])
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export interface MarkSoldInput {
  operator: string;
  idempotencyKey: string;
}

export async function markProductSold(input: MarkSoldInput): Promise<{ saleId: string }> {
  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    return { saleId: fastReplay };
  }

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const [state, products] = await Promise.all([getState(), getProducts()]);
    if (!state.currentProductId) throw new SalesError("There's no current product to mark sold.");

    const productIdx = products.findIndex((p) => p.id === state.currentProductId);
    if (productIdx === -1) throw new SalesError("The current product no longer exists.", 404);
    const product = products[productIdx];

    const expectedVersion = String((await redis.get<number>(CoreKeys.productVersion(product.id))) ?? 0);

    const salePrice = state.flashDeal.active
      ? Math.round(product.lootPrice * (1 - state.flashDeal.discountPercent / 100))
      : product.lootPrice;
    const nextInventory = Math.max(0, product.inventory - 1);
    const sale = makeSaleFromProduct(product, salePrice);

    const updatedProducts = [...products];
    updatedProducts[productIdx] = { ...product, inventory: nextInventory };

    const updatedState: LiveState = {
      ...state,
      recentSales: [sale, ...state.recentSales].slice(0, MAX_RECENT_SALES),
    };

    const lot = await findOldestLotWithStock(product.id);
    let transactionsWrite: InventoryTransaction[] = [];
    let landedCostAtSale: number | null = null;
    if (lot) {
      landedCostAtSale = lot.cost.landed;
      const transactions = await getAllInventoryTransactions();
      const transaction: InventoryTransaction = {
        id: newId("txn"),
        productId: product.id,
        poId: lot.poId,
        poLineId: lot.poLineId,
        lotId: lot.id,
        quantityDelta: -1,
        reason: "sale",
        receivingEventId: null,
        saleId: sale.id,
        operator: input.operator?.trim() || "Unknown",
        timestamp: new Date().toISOString(),
      };
      transactionsWrite = [...transactions, transaction];
    }

    const saleRecord: SaleRecord = {
      id: sale.id,
      productId: product.id,
      sku: product.sku,
      price: salePrice,
      quantity: 1,
      soldAt: sale.soldAt,
      status: "completed",
      lotId: lot?.id ?? null,
      landedCostAtSale,
      liveSessionId: null,
      presentationId: null,
      saleVersion: 0,
      originalPrice: null,
      correctedAt: null,
      correctedBy: null,
      canceledAt: null,
      canceledBy: null,
    };

    const aggregate = await getSalesAggregate(product.id);
    const updatedAggregate: SalesAggregate = {
      completedSaleCount: aggregate.completedSaleCount + 1,
      completedUnitsSold: aggregate.completedUnitsSold + 1,
      completedSalesRevenue: aggregate.completedSalesRevenue + salePrice,
    };

    const currentGlobalVersion = await getVersion();
    const timestampMs = Date.now();

    const keys = [
      idempotencyKeyOf(input.idempotencyKey),
      CoreKeys.productVersion(product.id),
      CoreKeys.products,
      CoreKeys.state,
      IntakeKeys.inventoryTransactions,
      saleKey(sale.id),
      aggregateKey(product.id),
      CoreKeys.version,
      byProductZsetKey(product.id),
      ALL_SALES_ZSET_KEY,
    ];
    const args = [
      sale.id,
      expectedVersion,
      String(Number(expectedVersion) + 1),
      JSON.stringify(updatedProducts),
      JSON.stringify(updatedState),
      JSON.stringify(transactionsWrite),
      JSON.stringify(saleRecord),
      JSON.stringify(updatedAggregate),
      String(currentGlobalVersion + 1),
      lot ? "1" : "0",
      String(timestampMs),
      sale.id,
    ];

    const result = await redis.eval<(string | number)[], string>(MARK_SOLD_SCRIPT, keys, args);
    if (result === "CONFLICT") {
      continue;
    }
    return { saleId: result };
  }

  throw new SalesError("Someone else just updated this product — please try again.", 409);
}

// ---------------------------------------------------------------------
// recordSale — Go Live's RECORD SALE. Generalizes the exact same
// read-plan/verify-at-commit/retry-on-conflict loop above to (a)
// arbitrary quantity spanning multiple lots and (b) a LiveSession +
// LivePresentation, WITHOUT trusting a plan computed in an earlier
// attempt or before the loop — every attempt re-reads productVersion AND
// the lots fresh, so a plan is only ever committed against the exact
// version it was computed from (see finding #13 of the approved plan).
// ---------------------------------------------------------------------

// KEYS[1]  idempotency key
// KEYS[2]  product version key
// KEYS[3]  products key
// KEYS[4]  inventory_transactions key (touched only if ARGV[12] == "1")
// KEYS[5]  sale record key
// KEYS[6]  per-product aggregate key
// KEYS[7]  global version key
// KEYS[8]  per-product sales zset key
// KEYS[9]  global sales zset key
// KEYS[10] presentation key
// KEYS[11] presentations-by-session zset key
// KEYS[12] per-session order sequence key (INCR'd here)
// KEYS[13] sale audit list key (RPUSH'd here)
//
// ARGV[1]  idempotency marker (JSON: {saleId, presentationId})
// ARGV[2]  expected product version (string)
// ARGV[3]  new product version (string)
// ARGV[4]  new products array (JSON)
// ARGV[5]  new inventory_transactions array (JSON) — ignored if ARGV[12] == "0"
// ARGV[6]  new sale record (JSON)
// ARGV[7]  new aggregate (JSON)
// ARGV[8]  new global version (string number)
// ARGV[9]  score for zadd (timestamp ms, string)
// ARGV[10] member for sales zsets (saleId)
// ARGV[11] new presentation (JSON)
// ARGV[12] "1" if lot(s) were consumed (touch KEYS[4]), else "0"
// ARGV[13] member for presentations-by-session zset (presentationId)
// ARGV[14] "created" audit event (JSON) — `"liveOrderNumber":null` is replaced
//          by the assigned number, exactly like in the sale record (ARGV[6])
const RECORD_LIVE_SALE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end

local currentVersion = redis.call('GET', KEYS[2])
if not currentVersion then
  currentVersion = '0'
end
if currentVersion ~= ARGV[2] then
  return 'CONFLICT'
end

redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
if ARGV[12] == '1' then
  redis.call('SET', KEYS[4], ARGV[5])
end
-- LIVE ORDER NUMBER: assigned HERE, after the idempotency and version
-- checks above, in the same atomic script that creates the sale. A replay or a
-- CONFLICT returned before this point never touches the sequence, so a failed
-- attempt can never consume (or later duplicate) a number.
local orderNo = redis.call('INCR', KEYS[12])
local saleJson = (string.gsub(ARGV[6], '"liveOrderNumber":null', '"liveOrderNumber":' .. orderNo, 1))
local auditJson = (string.gsub(ARGV[14], '"liveOrderNumber":null', '"liveOrderNumber":' .. orderNo, 1))
redis.call('SET', KEYS[5], saleJson)
redis.call('SET', KEYS[6], ARGV[7])
redis.call('SET', KEYS[7], ARGV[8])
redis.call('ZADD', KEYS[8], ARGV[9], ARGV[10])
redis.call('ZADD', KEYS[9], ARGV[9], ARGV[10])
redis.call('SET', KEYS[10], ARGV[11])
redis.call('ZADD', KEYS[11], ARGV[9], ARGV[13])
redis.call('RPUSH', KEYS[13], auditJson)
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export interface RecordSaleInput {
  liveSessionId: string;
  productId: string;
  quantity: number;
  /** TOTAL winning bid for this auction, across `quantity` units — never
   *  a per-unit price. */
  winningBid: number;
  operator: string;
  idempotencyKey: string;
  /** Record the sale even though the system shows too little stock ("Sell
   *  anyway"). Never set implicitly — the host must confirm it. */
  allowOversell?: boolean;
}

export interface RecordSaleResult {
  saleId: string;
  presentationId: string;
  /** The per-session LIVE Order number this sale was assigned. */
  liveOrderNumber: number | null;
}

export async function recordSale(input: RecordSaleInput): Promise<RecordSaleResult> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new SalesError("Quantity must be a positive whole number.");
  }
  if (!Number.isFinite(input.winningBid) || input.winningBid < 0) {
    throw new SalesError("Winning bid must be zero or greater.");
  }

  // The idempotency marker (and every other value a Lua script `return`s
  // or `SET`s here) is kept a bare id string on purpose, never a
  // JSON-shaped value — Upstash's client auto-deserializes any stored/
  // returned value that parses as JSON, so a marker written as
  // JSON.stringify({...}) round-trips back as an already-parsed object,
  // not the string this code expects. Reconstructing the full result
  // from the canonical SaleRecord (which IS meant to be read as an
  // object) avoids that trap entirely.
  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    const replayedSale = await getSaleRecordById(fastReplay);
    if (replayedSale) {
      return {
        saleId: replayedSale.id,
        presentationId: replayedSale.presentationId ?? "",
        liveOrderNumber: replayedSale.liveOrderNumber ?? null,
      };
    }
  }

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const products = await getProducts();
    const productIdx = products.findIndex((p) => p.id === input.productId);
    if (productIdx === -1) throw new SalesError("Product not found.", 404);
    const product = products[productIdx];

    const expectedVersion = String((await redis.get<number>(CoreKeys.productVersion(product.id))) ?? 0);

    const found = await findLotsToConsume(product.id, input.quantity);
    let lotPlan: { plan: LotConsumptionPlan; weightedLandedCost: number | null };
    let oversoldQuantity = 0;
    if (found === "insufficient" || (found.plan.length === 0 && product.inventory < input.quantity)) {
      if (!input.allowOversell) {
        throw new SalesError(
          `The system shows ${product.inventory} in stock for ${product.brand} ${product.name}, so it can't record ${input.quantity}.`,
          409,
          "insufficient_stock"
        );
      }
      // Host confirmed "Sell anyway": take what the lots still hold, the rest has no stock record.
      const partial = await planConsumeUpTo(product.id, input.quantity);
      const hasLots = partial.plan.length > 0 || partial.weightedLandedCost !== null;
      const covered = hasLots ? partial.coveredFromLots : Math.min(Math.max(product.inventory, 0), input.quantity);
      oversoldQuantity = input.quantity - covered;
      lotPlan = { plan: partial.plan, weightedLandedCost: partial.weightedLandedCost };
    } else {
      lotPlan = found;
    }

    const nextInventory = Math.max(0, product.inventory - input.quantity);
    const updatedProducts = [...products];
    updatedProducts[productIdx] = { ...product, inventory: nextInventory };

    const saleId = newId("sale");
    const presentationId = newId("pres");
    const timestamp = new Date().toISOString();
    const operator = input.operator?.trim() || "Unknown";

    let transactionsWrite: InventoryTransaction[] = [];
    if (lotPlan.plan.length > 0) {
      const existingTxns = await getAllInventoryTransactions();
      const newTxns: InventoryTransaction[] = lotPlan.plan.map((p) => ({
        id: newId("txn"),
        productId: product.id,
        poId: p.poId,
        poLineId: p.poLineId,
        lotId: p.lotId,
        quantityDelta: -p.qty,
        reason: "sale",
        receivingEventId: null,
        saleId,
        operator,
        timestamp,
      }));
      transactionsWrite = [...existingTxns, ...newTxns];
    }

    const saleRecord: SaleRecord = {
      id: saleId,
      productId: product.id,
      sku: product.sku,
      price: input.winningBid,
      quantity: input.quantity,
      soldAt: timestamp,
      status: "completed",
      lotId: lotPlan.plan[0]?.lotId ?? null,
      landedCostAtSale: lotPlan.weightedLandedCost,
      liveSessionId: input.liveSessionId,
      presentationId,
      saleVersion: 0,
      originalPrice: null,
      correctedAt: null,
      correctedBy: null,
      canceledAt: null,
      canceledBy: null,
      liveOrderNumber: null, // replaced atomically inside RECORD_LIVE_SALE_SCRIPT
      restoredAt: null,
      restoredBy: null,
      oversoldQuantity: oversoldQuantity > 0 ? oversoldQuantity : null,
    };

    const presentation: LivePresentation = {
      id: presentationId,
      liveSessionId: input.liveSessionId,
      productId: product.id,
      sku: product.sku,
      outcome: "sold",
      quantity: input.quantity,
      saleId,
      timestamp,
      operator,
    };

    const aggregate = await getSalesAggregate(product.id);
    const updatedAggregate: SalesAggregate = {
      completedSaleCount: aggregate.completedSaleCount + 1,
      completedUnitsSold: aggregate.completedUnitsSold + input.quantity,
      completedSalesRevenue: aggregate.completedSalesRevenue + input.winningBid,
    };

    const currentGlobalVersion = await getVersion();
    const timestampMs = Date.now();

    const keys = [
      idempotencyKeyOf(input.idempotencyKey),
      CoreKeys.productVersion(product.id),
      CoreKeys.products,
      IntakeKeys.inventoryTransactions,
      saleKey(saleId),
      aggregateKey(product.id),
      CoreKeys.version,
      byProductZsetKey(product.id),
      ALL_SALES_ZSET_KEY,
      presentationKey(presentationId),
      presentationsBySessionZsetKey(input.liveSessionId),
      sessionOrderSeqKey(input.liveSessionId),
      saleAuditKey(saleId),
    ];
    const createdEvent: SaleAuditEvent = {
      id: newId("aud"),
      saleId,
      liveOrderNumber: null, // replaced atomically with the assigned number
      action: "created",
      at: timestamp,
      operator,
      before: null,
      after: {
        productId: product.id,
        quantity: input.quantity,
        price: input.winningBid,
        landedCostAtSale: lotPlan.weightedLandedCost,
        ...(oversoldQuantity > 0 ? { oversoldQuantity } : {}),
      },
    };
    const args = [
      saleId, // bare idempotency marker — see comment above
      expectedVersion,
      String(Number(expectedVersion) + 1),
      JSON.stringify(updatedProducts),
      JSON.stringify(transactionsWrite),
      JSON.stringify(saleRecord),
      JSON.stringify(updatedAggregate),
      String(currentGlobalVersion + 1),
      String(timestampMs),
      saleId,
      JSON.stringify(presentation),
      lotPlan.plan.length > 0 ? "1" : "0",
      presentationId,
      JSON.stringify(createdEvent),
    ];

    const evalResult = await redis.eval<(string | number)[], string>(RECORD_LIVE_SALE_SCRIPT, keys, args);
    if (evalResult === "CONFLICT") {
      continue;
    }
    // evalResult is the bare saleId marker: this attempt's own id on success,
    // or the ORIGINAL sale's id when the script found the idempotency key
    // already used (a concurrent duplicate request). Always read the number
    // back from the canonical record.
    const finalSaleId = typeof evalResult === "string" && evalResult ? evalResult : saleId;
    const created = await getSaleRecordById(finalSaleId);
    return {
      saleId: finalSaleId,
      presentationId: created?.presentationId ?? presentationId,
      liveOrderNumber: created?.liveOrderNumber ?? null,
    };
  }

  throw new SalesError("Someone else just updated this product — please try again.", 409);
}

// ---------------------------------------------------------------------
// recordNoSale — the presentation write AND the idempotency commit
// happen in ONE script (finding #2 of the "final corrections" round):
// nothing here is a multi-step app-level sequence that could fail
// between "write presentation" and "mark idempotency key" and leave a
// retry able to duplicate it.
// ---------------------------------------------------------------------

// KEYS[1] idempotency key
// KEYS[2] presentation key
// KEYS[3] presentations-by-session zset key
// ARGV[1] idempotency marker (presentationId)
// ARGV[2] new presentation (JSON)
// ARGV[3] score (timestamp ms)
// ARGV[4] member (presentationId)
const NO_SALE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[4])
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export interface RecordNoSaleInput {
  liveSessionId: string;
  productId: string;
  sku: string;
  operator: string;
  idempotencyKey: string;
}

export async function recordNoSale(input: RecordNoSaleInput): Promise<{ presentationId: string }> {
  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) return { presentationId: fastReplay };

  const presentationId = newId("pres");
  const presentation: LivePresentation = {
    id: presentationId,
    liveSessionId: input.liveSessionId,
    productId: input.productId,
    sku: input.sku,
    outcome: "no_sale",
    quantity: 0,
    saleId: null,
    timestamp: new Date().toISOString(),
    operator: input.operator?.trim() || "Unknown",
  };

  const keys = [
    idempotencyKeyOf(input.idempotencyKey),
    presentationKey(presentationId),
    presentationsBySessionZsetKey(input.liveSessionId),
  ];
  const args = [presentationId, JSON.stringify(presentation), String(Date.now()), presentationId];

  const result = await redis.eval<(string | number)[], string>(NO_SALE_SCRIPT, keys, args);
  return { presentationId: result };
}

// ---------------------------------------------------------------------
// cancelSale / correctSalePrice — both CAS on SaleRecord.saleVersion so
// two DIFFERENT racing requests against the same sale can't both compute
// their effect off the same stale read (idempotency alone only protects
// against the SAME request retried). cancelSale additionally CASes
// Product.inventory's own productVersion, since it's the one operation
// that changes two independently-shared pieces of state at once — see
// the final two correction rounds of the approved plan. Both scripts
// re-derive "current" via their own GET+decode inside Lua rather than
// trusting a value the caller read earlier — there's no gap between "we
// checked" and "we wrote."
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Ledger mutations (edit / restore): ONE generic compare-and-swap script.
//
// Edit and restore touch different keys, but share the same guarantees —
// idempotency, a CAS on the sale's own saleVersion + required status, a CAS on
// every affected product's version, then a flat list of writes, the audit
// events and (optionally) zset moves, all inside one Lua script, so the sale,
// the inventory and the audit trail either all change or none do. The
// script never decides anything: the caller has re-read and re-planned
// against the exact versions it passes in (retrying on CONFLICT).
//
// KEYS[1] idempotency key          KEYS[2] sale record key
// KEYS[3] audit list key           KEYS[4 .. 3+P] product version keys
// KEYS[4+P .. 3+P+W] write keys    KEYS[4+P+W ..] zset keys (one per zset op)
// ARGV: 1 marker | 2 expected saleVersion | 3 required status | 4 P |
//       5..4+P expected product versions | 5+P W | W write values |
//       A | A audit events (JSON) | Z | Z x (op, member, score)
// ---------------------------------------------------------------------
const LEDGER_MUTATION_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
local raw = redis.call('GET', KEYS[2])
if not raw then
  return 'NOT_FOUND'
end
local sale = cjson.decode(raw)
local status = sale.status or 'completed'
if status ~= ARGV[3] then
  return 'BAD_STATUS'
end
if tostring(sale.saleVersion or 0) ~= ARGV[2] then
  return 'CONFLICT'
end
local P = tonumber(ARGV[4])
for i = 1, P do
  local cur = redis.call('GET', KEYS[3 + i])
  if not cur then
    cur = '0'
  end
  if cur ~= ARGV[4 + i] then
    return 'CONFLICT'
  end
end
local W = tonumber(ARGV[5 + P])
for i = 1, W do
  redis.call('SET', KEYS[3 + P + i], ARGV[5 + P + i])
end
local A = tonumber(ARGV[6 + P + W])
for i = 1, A do
  redis.call('RPUSH', KEYS[3], ARGV[6 + P + W + i])
end
redis.call('LTRIM', KEYS[3], -${SALE_AUDIT_MAX_EVENTS}, -1)
local Z = tonumber(ARGV[7 + P + W + A])
for i = 1, Z do
  local base = 7 + P + W + A + (i - 1) * 3
  local key = KEYS[3 + P + W + i]
  if ARGV[base + 1] == 'ZADD' then
    redis.call('ZADD', key, ARGV[base + 3], ARGV[base + 2])
  else
    redis.call('ZREM', key, ARGV[base + 2])
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

interface LedgerMutation {
  idempotencyKey: string;
  sale: SaleRecord; // the version the plan was computed from
  requiredStatus: "completed" | "canceled";
  productVersionChecks: { key: string; expected: string }[];
  writes: { key: string; value: unknown }[];
  auditEvents: SaleAuditEvent[];
  zsetOps: { op: "ZADD" | "ZREM"; key: string; member: string; score?: number }[];
}

async function runLedgerMutation(m: LedgerMutation): Promise<string> {
  const keys = [
    idempotencyKeyOf(m.idempotencyKey),
    saleKey(m.sale.id),
    saleAuditKey(m.sale.id),
    ...m.productVersionChecks.map((c) => c.key),
    ...m.writes.map((w) => w.key),
    ...m.zsetOps.map((z) => z.key),
  ];
  const args: string[] = [
    m.sale.id,
    String(m.sale.saleVersion),
    m.requiredStatus,
    String(m.productVersionChecks.length),
    ...m.productVersionChecks.map((c) => c.expected),
    String(m.writes.length),
    ...m.writes.map((w) => (typeof w.value === "string" ? w.value : JSON.stringify(w.value))),
    String(m.auditEvents.length),
    ...m.auditEvents.map((e) => JSON.stringify(e)),
    String(m.zsetOps.length),
    ...m.zsetOps.flatMap((z) => [z.op, z.member, String(z.score ?? 0)]),
  ];
  return redis.eval<string[], string>(LEDGER_MUTATION_SCRIPT, keys, args);
}

/** Orders of an ENDED Live are read-only: edit, cancel and restore are refused
 *  server-side (the UI also hides the controls). */
async function assertSaleEditable(sale: SaleRecord): Promise<void> {
  if (!sale.liveSessionId) return;
  // same literal as live-db.ts's KEYS.session — not imported to avoid a cycle
  const session = await redis.get<{ status?: string }>(`amoruh:live:session:${sale.liveSessionId}`);
  if (session?.status === "ended") {
    throw new SalesError("This Live has ended, so its orders are read-only.", 409);
  }
}

function auditEvent(
  sale: SaleRecord,
  action: SaleAuditAction,
  operator: string,
  at: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): SaleAuditEvent {
  return { id: newId("aud"), saleId: sale.id, liveOrderNumber: sale.liveOrderNumber ?? null, action, at, operator, before, after };
}

function cleanOperator(operator: string | undefined): string {
  return operator?.trim() || "Unknown";
}

// ---------------------------------------------------------------------
// editSale — selling price, quantity and/or product of an ACTIVE order, in one
// atomic step (inventory + lots + aggregates + presentation + audit).
//
//  - price only        → no inventory change.
//  - quantity change   → only the DIFFERENCE moves: extra units are taken from
//    the oldest lots with stock; removed units go back to the lots this sale
//    consumed (most recently consumed first). The frozen unit cost is kept for
//    a decrease; an increase blends in the newly consumed lots' cost.
//  - product change    → everything this sale consumed goes back to the
//    original product, then the new product is decremented, and the new
//    product's own weighted landed cost is snapshotted (null when it has no
//    lot data, exactly like a fresh sale of such a product).
// The previous values always survive in the audit list.
// ---------------------------------------------------------------------

export interface EditSaleInput {
  saleId: string;
  newPrice?: number;
  newQuantity?: number;
  newProductId?: string;
  operator: string;
  idempotencyKey: string;
}

export async function editSale(input: EditSaleInput): Promise<SaleRecord> {
  if (input.newPrice !== undefined && (!Number.isFinite(input.newPrice) || input.newPrice < 0)) {
    throw new SalesError("Price must be zero or greater.");
  }
  if (input.newQuantity !== undefined && (!Number.isInteger(input.newQuantity) || input.newQuantity <= 0)) {
    throw new SalesError("Quantity must be a positive whole number.");
  }

  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    const replayed = await getSaleRecordById(input.saleId);
    if (replayed) return replayed;
  }

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const sale = await getSaleRecordById(input.saleId);
    if (!sale) throw new SalesError("Sale not found.", 404);
    if (sale.status === "canceled") throw new SalesError("This order is canceled — restore it before editing.");
    await assertSaleEditable(sale);

    const price = input.newPrice ?? sale.price;
    const quantity = input.newQuantity ?? sale.quantity;
    const productId = input.newProductId ?? sale.productId;
    const priceChanged = price !== sale.price;
    const quantityChanged = quantity !== sale.quantity;
    const productChanged = productId !== sale.productId;
    if (!priceChanged && !quantityChanged && !productChanged) return sale; // nothing to change
    if ((quantityChanged || productChanged) && (sale.oversoldQuantity ?? 0) > 0) {
      throw new SalesError(
        "This order was sold beyond the recorded stock, so only its price can be edited. Cancel it and enter a new sale to change the quantity or product."
      );
    }

    const products = await getProducts();
    const oldIdx = products.findIndex((p) => p.id === sale.productId);
    const newIdx = products.findIndex((p) => p.id === productId);
    if (oldIdx === -1) throw new SalesError("The sold product no longer exists.", 404);
    if (newIdx === -1) throw new SalesError("Product not found.", 404);
    const oldProduct = products[oldIdx];
    const newProduct = products[newIdx];

    const operator = cleanOperator(input.operator);
    const timestamp = new Date().toISOString();
    const inventoryTouched = quantityChanged || productChanged;

    const updatedProducts = [...products];
    const writes: LedgerMutation["writes"] = [];
    const productVersionChecks: LedgerMutation["productVersionChecks"] = [];
    const zsetOps: LedgerMutation["zsetOps"] = [];
    let landedCostAtSale = sale.landedCostAtSale;
    let lotId = sale.lotId;

    if (inventoryTouched) {
      const allTxns = await getAllInventoryTransactions();
      const saleTxns = allTxns.filter((t) => t.saleId === sale.id);
      // net units this sale currently holds per lot, in first-consumed order
      const heldByLot = new Map<string, { qty: number; poId: string | null; poLineId: string | null }>();
      for (const t of saleTxns) {
        const cur = heldByLot.get(t.lotId) ?? { qty: 0, poId: t.poId ?? null, poLineId: t.poLineId ?? null };
        cur.qty += -t.quantityDelta;
        heldByLot.set(t.lotId, cur);
      }
      const newTxns: InventoryTransaction[] = [];
      const reversal = (productIdOfLots: string, lot: string, info: { poId: string | null; poLineId: string | null }, qty: number): InventoryTransaction => ({
        id: newId("txn"),
        productId: productIdOfLots,
        poId: info.poId,
        poLineId: info.poLineId,
        lotId: lot,
        quantityDelta: qty,
        reason: "sale_reversal",
        receivingEventId: null,
        saleId: sale.id,
        operator,
        timestamp,
      });

      const oldVersion = String((await redis.get<number>(CoreKeys.productVersion(oldProduct.id))) ?? 0);
      productVersionChecks.push({ key: CoreKeys.productVersion(oldProduct.id), expected: oldVersion });

      if (!productChanged) {
        const diff = quantity - sale.quantity;
        if (diff > 0) {
          const plan = await findLotsToConsume(oldProduct.id, diff);
          if (plan === "insufficient") {
            throw new SalesError(`Not enough stock to add ${diff} more unit(s) — check Inventory for the current count.`);
          }
          if (plan.plan.length === 0 && oldProduct.inventory < diff) {
            throw new SalesError(`Only ${oldProduct.inventory} more unit(s) in stock — cannot add ${diff}.`);
          }
          for (const p of plan.plan) {
            newTxns.push({
              id: newId("txn"), productId: oldProduct.id, poId: p.poId, poLineId: p.poLineId, lotId: p.lotId,
              quantityDelta: -p.qty, reason: "sale", receivingEventId: null, saleId: sale.id, operator, timestamp,
            });
          }
          if (landedCostAtSale !== null && plan.plan.length > 0) {
            const addedCost = plan.plan.reduce((sum, p) => sum + p.qty * p.unitLandedCost, 0);
            landedCostAtSale = (sale.quantity * landedCostAtSale + addedCost) / quantity;
          }
          if (plan.plan.length > 0 && !lotId) lotId = plan.plan[0].lotId;
          updatedProducts[oldIdx] = { ...oldProduct, inventory: Math.max(0, oldProduct.inventory - diff) };
        } else {
          let remove = -diff;
          const lots = [...heldByLot.entries()].reverse(); // most recently consumed first
          for (const [lot, info] of lots) {
            if (remove <= 0) break;
            const take = Math.min(info.qty, remove);
            if (take > 0) newTxns.push(reversal(oldProduct.id, lot, info, take));
            remove -= Math.max(0, take);
          }
          // a legacy product with no lot data has no txns; Product.inventory still moves
          updatedProducts[oldIdx] = { ...oldProduct, inventory: oldProduct.inventory + -diff };
        }
        writes.push({ key: CoreKeys.productVersion(oldProduct.id), value: String(Number(oldVersion) + 1) });
      } else {
        const newVersion = String((await redis.get<number>(CoreKeys.productVersion(newProduct.id))) ?? 0);
        productVersionChecks.push({ key: CoreKeys.productVersion(newProduct.id), expected: newVersion });

        // 1. everything this sale holds goes back to the ORIGINAL product
        for (const [lot, info] of heldByLot) {
          if (info.qty > 0) newTxns.push(reversal(oldProduct.id, lot, info, info.qty));
        }
        updatedProducts[oldIdx] = { ...oldProduct, inventory: oldProduct.inventory + sale.quantity };

        // 2. the REPLACEMENT product is decremented, with its own cost snapshot
        const plan = await findLotsToConsume(newProduct.id, quantity);
        if (plan === "insufficient") {
          throw new SalesError(`Not enough stock of the replacement product to sell ${quantity}.`);
        }
        if (plan.plan.length === 0 && newProduct.inventory < quantity) {
          throw new SalesError(`Only ${newProduct.inventory} unit(s) of the replacement product in stock — cannot sell ${quantity}.`);
        }
        for (const p of plan.plan) {
          newTxns.push({
            id: newId("txn"), productId: newProduct.id, poId: p.poId, poLineId: p.poLineId, lotId: p.lotId,
            quantityDelta: -p.qty, reason: "sale", receivingEventId: null, saleId: sale.id, operator, timestamp,
          });
        }
        landedCostAtSale = plan.weightedLandedCost;
        lotId = plan.plan[0]?.lotId ?? null;
        updatedProducts[newIdx] = { ...updatedProducts[newIdx], inventory: Math.max(0, updatedProducts[newIdx].inventory - quantity) };

        writes.push({ key: CoreKeys.productVersion(oldProduct.id), value: String(Number(oldVersion) + 1) });
        writes.push({ key: CoreKeys.productVersion(newProduct.id), value: String(Number(newVersion) + 1) });
        zsetOps.push({ op: "ZREM", key: byProductZsetKey(oldProduct.id), member: sale.id });
        zsetOps.push({ op: "ZADD", key: byProductZsetKey(newProduct.id), member: sale.id, score: new Date(sale.soldAt).getTime() });
      }

      writes.push({ key: CoreKeys.products, value: updatedProducts });
      if (newTxns.length > 0) writes.push({ key: IntakeKeys.inventoryTransactions, value: [...allTxns, ...newTxns] });
    }

    // durable per-product aggregates
    if (!productChanged) {
      const agg = await getSalesAggregate(oldProduct.id);
      writes.push({
        key: aggregateKey(oldProduct.id),
        value: {
          completedSaleCount: agg.completedSaleCount,
          completedUnitsSold: agg.completedUnitsSold + (quantity - sale.quantity),
          completedSalesRevenue: agg.completedSalesRevenue + (price - sale.price),
        } satisfies SalesAggregate,
      });
    } else {
      const [oldAgg, newAgg] = await Promise.all([getSalesAggregate(oldProduct.id), getSalesAggregate(newProduct.id)]);
      writes.push({
        key: aggregateKey(oldProduct.id),
        value: {
          completedSaleCount: Math.max(0, oldAgg.completedSaleCount - 1),
          completedUnitsSold: Math.max(0, oldAgg.completedUnitsSold - sale.quantity),
          completedSalesRevenue: oldAgg.completedSalesRevenue - sale.price,
        } satisfies SalesAggregate,
      });
      writes.push({
        key: aggregateKey(newProduct.id),
        value: {
          completedSaleCount: newAgg.completedSaleCount + 1,
          completedUnitsSold: newAgg.completedUnitsSold + quantity,
          completedSalesRevenue: newAgg.completedSalesRevenue + price,
        } satisfies SalesAggregate,
      });
    }

    const updatedSale: SaleRecord = {
      ...sale,
      price,
      quantity,
      productId,
      sku: productChanged ? newProduct.sku : sale.sku,
      lotId,
      landedCostAtSale,
      originalPrice: priceChanged ? sale.originalPrice ?? sale.price : sale.originalPrice,
      correctedAt: priceChanged ? timestamp : sale.correctedAt,
      correctedBy: priceChanged ? operator : sale.correctedBy,
      saleVersion: sale.saleVersion + 1,
    };
    writes.push({ key: saleKey(sale.id), value: updatedSale });

    if (sale.presentationId && (productChanged || quantityChanged)) {
      const presentation = await redis.get<LivePresentation>(presentationKey(sale.presentationId));
      if (presentation) {
        writes.push({
          key: presentationKey(sale.presentationId),
          value: { ...presentation, productId, sku: productChanged ? newProduct.sku : presentation.sku, quantity },
        });
      }
    }

    const events: SaleAuditEvent[] = [];
    if (priceChanged) events.push(auditEvent(sale, "price_changed", operator, timestamp, { price: sale.price }, { price }));
    if (quantityChanged) events.push(auditEvent(sale, "quantity_changed", operator, timestamp, { quantity: sale.quantity }, { quantity }));
    if (productChanged) {
      events.push(
        auditEvent(
          sale,
          "product_changed",
          operator,
          timestamp,
          { productId: sale.productId, sku: sale.sku, name: `${oldProduct.brand} ${oldProduct.name}`, landedCostAtSale: sale.landedCostAtSale },
          { productId, sku: newProduct.sku, name: `${newProduct.brand} ${newProduct.name}`, landedCostAtSale }
        )
      );
    }

    const result = await runLedgerMutation({
      idempotencyKey: input.idempotencyKey,
      sale,
      requiredStatus: "completed",
      productVersionChecks,
      writes,
      auditEvents: events,
      zsetOps,
    });
    if (result === "CONFLICT") continue;
    if (result === "NOT_FOUND") throw new SalesError("Sale not found.", 404);
    if (result === "BAD_STATUS") throw new SalesError("This order was canceled — restore it before editing.");
    return (await getSaleRecordById(sale.id)) ?? updatedSale;
  }

  throw new SalesError("Someone else just updated this order or product — please try again.", 409);
}

// ---------------------------------------------------------------------
// restoreSale — reactivates a canceled order under its ORIGINAL number.
// Inventory is decremented again under the normal stock rules (and refused
// when there isn't enough), the frozen cost is kept, and the status flip is
// CAS-guarded so a double-click / two tabs restore it exactly once.
// ---------------------------------------------------------------------

export interface RestoreSaleInput {
  saleId: string;
  operator: string;
  idempotencyKey: string;
}

export async function restoreSale(input: RestoreSaleInput): Promise<SaleRecord> {
  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    const replayed = await getSaleRecordById(input.saleId);
    if (replayed) return replayed;
  }

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const sale = await getSaleRecordById(input.saleId);
    if (!sale) throw new SalesError("Sale not found.", 404);
    if (sale.status === "completed") return sale; // already active: idempotent no-op
    if (sale.status !== "canceled") throw new SalesError("Only a canceled order can be restored.");
    await assertSaleEditable(sale);

    const products = await getProducts();
    const productIdx = products.findIndex((p) => p.id === sale.productId);
    if (productIdx === -1) throw new SalesError("The sold product no longer exists.", 404);
    const product = products[productIdx];
    const expectedVersion = String((await redis.get<number>(CoreKeys.productVersion(product.id))) ?? 0);

    const trackedUnits = Math.max(0, sale.quantity - (sale.oversoldQuantity ?? 0));
    const plan = trackedUnits > 0 ? await findLotsToConsume(product.id, trackedUnits) : { plan: [] as LotConsumptionPlan, weightedLandedCost: null };
    if (plan === "insufficient" || (trackedUnits > 0 && plan.plan.length === 0 && product.inventory < trackedUnits)) {
      throw new SalesError(
        `Not enough stock to restore this order — it needs ${trackedUnits} unit(s) of ${product.brand} ${product.name}.`,
        409
      );
    }

    const operator = cleanOperator(input.operator);
    const timestamp = new Date().toISOString();
    const allTxns = await getAllInventoryTransactions();
    const newTxns: InventoryTransaction[] = plan.plan.map((p) => ({
      id: newId("txn"),
      productId: product.id,
      poId: p.poId,
      poLineId: p.poLineId,
      lotId: p.lotId,
      quantityDelta: -p.qty,
      reason: "sale",
      receivingEventId: null,
      saleId: sale.id,
      operator,
      timestamp,
    }));
    const updatedProducts = [...products];
    updatedProducts[productIdx] = { ...product, inventory: Math.max(0, product.inventory - trackedUnits) };

    const updatedSale: SaleRecord = {
      ...sale,
      status: "completed",
      restoredAt: timestamp,
      restoredBy: operator,
      lotId: plan.plan[0]?.lotId ?? sale.lotId,
      // landedCostAtSale is deliberately untouched: cost stays what it was at the time of sale
      saleVersion: sale.saleVersion + 1,
    };
    const agg = await getSalesAggregate(product.id);

    const writes: LedgerMutation["writes"] = [
      { key: saleKey(sale.id), value: updatedSale },
      { key: CoreKeys.products, value: updatedProducts },
      { key: CoreKeys.productVersion(product.id), value: String(Number(expectedVersion) + 1) },
      {
        key: aggregateKey(product.id),
        value: {
          completedSaleCount: agg.completedSaleCount + 1,
          completedUnitsSold: agg.completedUnitsSold + sale.quantity,
          completedSalesRevenue: agg.completedSalesRevenue + sale.price,
        } satisfies SalesAggregate,
      },
    ];
    if (newTxns.length > 0) writes.push({ key: IntakeKeys.inventoryTransactions, value: [...allTxns, ...newTxns] });

    const result = await runLedgerMutation({
      idempotencyKey: input.idempotencyKey,
      sale,
      requiredStatus: "canceled",
      productVersionChecks: [{ key: CoreKeys.productVersion(product.id), expected: expectedVersion }],
      writes,
      auditEvents: [auditEvent(sale, "restored", operator, timestamp, { status: "canceled" }, { status: "completed" })],
      zsetOps: [],
    });
    if (result === "CONFLICT") continue;
    if (result === "NOT_FOUND") throw new SalesError("Sale not found.", 404);
    if (result === "BAD_STATUS") {
      const latest = await getSaleRecordById(sale.id); // someone else already restored it
      return latest ?? updatedSale;
    }
    return (await getSaleRecordById(sale.id)) ?? updatedSale;
  }

  throw new SalesError("Someone else just updated this order or product — please try again.", 409);
}

export interface CorrectSalePriceInput {
  saleId: string;
  newPrice: number;
  operator: string;
  idempotencyKey: string;
}

/** Kept for the existing /api/live/correct-sale route: a price-only editSale. */
export async function correctSalePrice(input: CorrectSalePriceInput): Promise<SaleRecord> {
  return editSale({ saleId: input.saleId, newPrice: input.newPrice, operator: input.operator, idempotencyKey: input.idempotencyKey });
}

// KEYS[1] idempotency key
// KEYS[2] sale record key
// KEYS[3] per-product aggregate key
// KEYS[4] product version key
// KEYS[5] products key
// KEYS[6] inventory_transactions key
// KEYS[7] sale audit list key
// ARGV[1] idempotency marker
// ARGV[2] expected saleVersion (string)
// ARGV[3] expected productVersion (string)
// ARGV[4] new sale record (JSON)
// ARGV[5] new aggregate (JSON)
// ARGV[6] new productVersion (string)
// ARGV[7] new products array (JSON)
// ARGV[8] new inventory_transactions array (JSON)
// ARGV[9] "canceled" audit event (JSON)
const CANCEL_SALE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
local raw = redis.call('GET', KEYS[2])
if not raw then
  return 'NOT_FOUND'
end
local sale = cjson.decode(raw)
if sale.status == 'canceled' then
  return 'ALREADY_CANCELED'
end
local currentSaleVersion = sale.saleVersion or 0
if tostring(currentSaleVersion) ~= ARGV[2] then
  return 'CONFLICT'
end
local currentProductVersion = redis.call('GET', KEYS[4])
if not currentProductVersion then
  currentProductVersion = '0'
end
if currentProductVersion ~= ARGV[3] then
  return 'CONFLICT'
end
redis.call('SET', KEYS[2], ARGV[4])
redis.call('SET', KEYS[3], ARGV[5])
redis.call('SET', KEYS[4], ARGV[6])
redis.call('SET', KEYS[5], ARGV[7])
redis.call('SET', KEYS[6], ARGV[8])
redis.call('RPUSH', KEYS[7], ARGV[9])
redis.call('LTRIM', KEYS[7], -${SALE_AUDIT_MAX_EVENTS}, -1)
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export interface CancelSaleInput {
  saleId: string;
  operator: string;
  idempotencyKey: string;
}

export async function cancelSale(input: CancelSaleInput): Promise<SaleRecord> {
  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    const replayed = await getSaleRecordById(input.saleId);
    if (replayed) return replayed;
  }

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const sale = await getSaleRecordById(input.saleId);
    if (!sale) throw new SalesError("Sale not found.", 404);
    if (sale.status === "canceled") return sale; // idempotent no-op, not an error
    await assertSaleEditable(sale);

    const products = await getProducts();
    const productIdx = products.findIndex((p) => p.id === sale.productId);
    if (productIdx === -1) throw new SalesError("The sold product no longer exists.", 404);
    const product = products[productIdx];
    const expectedProductVersion = String((await redis.get<number>(CoreKeys.productVersion(product.id))) ?? 0);

    const allTxns = await getAllInventoryTransactions();
    // Reverse the units this sale CURRENTLY holds per lot (sales minus any
    // earlier reversals — an order that was edited, or canceled and restored
    // before, must not be reversed twice).
    const timestamp = new Date().toISOString();
    const operator = input.operator?.trim() || "Unknown";
    const heldByLot = new Map<string, { qty: number; poId: string | null; poLineId: string | null }>();
    for (const t of allTxns) {
      if (t.saleId !== sale.id) continue;
      const cur = heldByLot.get(t.lotId) ?? { qty: 0, poId: t.poId ?? null, poLineId: t.poLineId ?? null };
      cur.qty += -t.quantityDelta;
      heldByLot.set(t.lotId, cur);
    }
    const reversalTxns: InventoryTransaction[] = [...heldByLot.entries()]
      .filter(([, info]) => info.qty > 0)
      .map(([lotId, info]) => ({
        id: newId("txn"),
        productId: product.id,
        poId: info.poId,
        poLineId: info.poLineId,
        lotId,
        quantityDelta: info.qty,
        reason: "sale_reversal" as const,
        receivingEventId: null,
        saleId: sale.id,
        operator,
        timestamp,
      }));

    // units the system never had on record (a "Sell anyway" sale) have nothing to give back
    const trackedUnits = Math.max(0, sale.quantity - (sale.oversoldQuantity ?? 0));
    const updatedProducts = [...products];
    updatedProducts[productIdx] = { ...product, inventory: product.inventory + trackedUnits };

    const updatedSale: SaleRecord = {
      ...sale,
      status: "canceled",
      canceledAt: timestamp,
      canceledBy: operator,
      saleVersion: sale.saleVersion + 1,
    };

    const aggregate = await getSalesAggregate(sale.productId);
    const updatedAggregate: SalesAggregate = {
      completedSaleCount: Math.max(0, aggregate.completedSaleCount - 1),
      completedUnitsSold: Math.max(0, aggregate.completedUnitsSold - sale.quantity),
      completedSalesRevenue: aggregate.completedSalesRevenue - sale.price,
    };

    const keys = [
      idempotencyKeyOf(input.idempotencyKey),
      saleKey(sale.id),
      aggregateKey(sale.productId),
      CoreKeys.productVersion(product.id),
      CoreKeys.products,
      IntakeKeys.inventoryTransactions,
      saleAuditKey(sale.id),
    ];
    const args = [
      sale.id,
      String(sale.saleVersion),
      expectedProductVersion,
      JSON.stringify(updatedSale),
      JSON.stringify(updatedAggregate),
      String(Number(expectedProductVersion) + 1),
      JSON.stringify(updatedProducts),
      JSON.stringify([...allTxns, ...reversalTxns]),
      JSON.stringify(auditEvent(sale, "canceled", operator, timestamp, { status: sale.status }, { status: "canceled" })),
    ];

    const result = await redis.eval<(string | number)[], string>(CANCEL_SALE_SCRIPT, keys, args);
    if (result === "CONFLICT") continue;
    if (result === "ALREADY_CANCELED") {
      const latest = await getSaleRecordById(sale.id);
      return latest ?? updatedSale;
    }
    if (result === "NOT_FOUND") throw new SalesError("Sale not found.", 404);
    return updatedSale;
  }

  throw new SalesError("Someone else just updated this sale or product — please try again.", 409);
}
