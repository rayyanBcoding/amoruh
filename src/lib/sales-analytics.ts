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
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SalesError";
    this.status = status;
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
function aggregateKey(productId: string): string {
  return `amoruh:sales:aggregate:${productId}`;
}
function byProductZsetKey(productId: string): string {
  return `amoruh:sales:by_product:${productId}`;
}
const ALL_SALES_ZSET_KEY = "amoruh:sales:all";

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
function normalizeSaleRecord(raw: SaleRecord): SaleRecord {
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
  };
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
redis.call('SET', KEYS[5], ARGV[6])
redis.call('SET', KEYS[6], ARGV[7])
redis.call('SET', KEYS[7], ARGV[8])
redis.call('ZADD', KEYS[8], ARGV[9], ARGV[10])
redis.call('ZADD', KEYS[9], ARGV[9], ARGV[10])
redis.call('SET', KEYS[10], ARGV[11])
redis.call('ZADD', KEYS[11], ARGV[9], ARGV[13])
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
}

export interface RecordSaleResult {
  saleId: string;
  presentationId: string;
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
    if (replayedSale) return { saleId: replayedSale.id, presentationId: replayedSale.presentationId ?? "" };
  }

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const products = await getProducts();
    const productIdx = products.findIndex((p) => p.id === input.productId);
    if (productIdx === -1) throw new SalesError("Product not found.", 404);
    const product = products[productIdx];

    const expectedVersion = String((await redis.get<number>(CoreKeys.productVersion(product.id))) ?? 0);

    const lotPlan = await findLotsToConsume(product.id, input.quantity);
    if (lotPlan === "insufficient") {
      throw new SalesError(`Not enough stock to sell ${input.quantity} — check Inventory for the current count.`);
    }
    if (lotPlan.plan.length === 0 && product.inventory < input.quantity) {
      throw new SalesError(`Only ${product.inventory} unit(s) in stock — cannot sell ${input.quantity}.`);
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
    ];
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
    ];

    const evalResult = await redis.eval<(string | number)[], string>(RECORD_LIVE_SALE_SCRIPT, keys, args);
    if (evalResult === "CONFLICT") {
      continue;
    }
    // evalResult is just the bare saleId (ARGV[1]) on success or replay —
    // both cases resolve to the sale/presentation ids this attempt itself
    // computed.
    return { saleId, presentationId };
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

// KEYS[1] idempotency key
// KEYS[2] sale record key
// KEYS[3] per-product aggregate key
// ARGV[1] idempotency marker
// ARGV[2] expected saleVersion (string)
// ARGV[3] new sale record (JSON)
// ARGV[4] new aggregate (JSON)
const CORRECT_SALE_SCRIPT = `
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
  return 'CANCELED'
end
local currentSaleVersion = sale.saleVersion or 0
if tostring(currentSaleVersion) ~= ARGV[2] then
  return 'CONFLICT'
end
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export interface CorrectSalePriceInput {
  saleId: string;
  newPrice: number;
  operator: string;
  idempotencyKey: string;
}

export async function correctSalePrice(input: CorrectSalePriceInput): Promise<SaleRecord> {
  if (!Number.isFinite(input.newPrice) || input.newPrice < 0) {
    throw new SalesError("Corrected price must be zero or greater.");
  }

  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    const replayed = await getSaleRecordById(input.saleId);
    if (replayed) return replayed;
  }

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const sale = await getSaleRecordById(input.saleId);
    if (!sale) throw new SalesError("Sale not found.", 404);
    if (sale.status === "canceled") throw new SalesError("This sale was canceled — it can't be corrected.");

    const priorEffectivePrice = sale.price;
    const updatedSale: SaleRecord = {
      ...sale,
      price: input.newPrice,
      originalPrice: sale.originalPrice ?? sale.price, // set only on the first-ever correction
      correctedAt: new Date().toISOString(),
      correctedBy: input.operator?.trim() || "Unknown",
      saleVersion: sale.saleVersion + 1,
    };

    const aggregate = await getSalesAggregate(sale.productId);
    const updatedAggregate: SalesAggregate = {
      ...aggregate,
      completedSalesRevenue: aggregate.completedSalesRevenue + (input.newPrice - priorEffectivePrice),
    };

    const keys = [idempotencyKeyOf(input.idempotencyKey), saleKey(sale.id), aggregateKey(sale.productId)];
    const args = [sale.id, String(sale.saleVersion), JSON.stringify(updatedSale), JSON.stringify(updatedAggregate)];

    const result = await redis.eval<(string | number)[], string>(CORRECT_SALE_SCRIPT, keys, args);
    if (result === "CONFLICT") continue;
    if (result === "CANCELED") throw new SalesError("This sale was canceled — it can't be corrected.");
    if (result === "NOT_FOUND") throw new SalesError("Sale not found.", 404);
    return updatedSale;
  }

  throw new SalesError("Someone else just updated this sale — please try again.", 409);
}

// KEYS[1] idempotency key
// KEYS[2] sale record key
// KEYS[3] per-product aggregate key
// KEYS[4] product version key
// KEYS[5] products key
// KEYS[6] inventory_transactions key
// ARGV[1] idempotency marker
// ARGV[2] expected saleVersion (string)
// ARGV[3] expected productVersion (string)
// ARGV[4] new sale record (JSON)
// ARGV[5] new aggregate (JSON)
// ARGV[6] new productVersion (string)
// ARGV[7] new products array (JSON)
// ARGV[8] new inventory_transactions array (JSON)
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

    const products = await getProducts();
    const productIdx = products.findIndex((p) => p.id === sale.productId);
    if (productIdx === -1) throw new SalesError("The sold product no longer exists.", 404);
    const product = products[productIdx];
    const expectedProductVersion = String((await redis.get<number>(CoreKeys.productVersion(product.id))) ?? 0);

    const allTxns = await getAllInventoryTransactions();
    const originalTxns = allTxns.filter((t) => t.saleId === sale.id && t.reason === "sale");
    const timestamp = new Date().toISOString();
    const operator = input.operator?.trim() || "Unknown";
    const reversalTxns: InventoryTransaction[] = originalTxns.map((t) => ({
      id: newId("txn"),
      productId: t.productId,
      poId: t.poId,
      poLineId: t.poLineId,
      lotId: t.lotId,
      quantityDelta: -t.quantityDelta, // original was negative (consumed); reversal is positive
      reason: "sale_reversal",
      receivingEventId: null,
      saleId: sale.id,
      operator,
      timestamp,
    }));

    const updatedProducts = [...products];
    updatedProducts[productIdx] = { ...product, inventory: product.inventory + sale.quantity };

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
