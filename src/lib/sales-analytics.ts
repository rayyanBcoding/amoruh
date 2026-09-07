import { redis, KEYS as CoreKeys } from "./kv";
import { getProducts, getState, getVersion, makeSaleFromProduct } from "./db";
import { checkIdempotencyFast, idempotencyKeyOf } from "./atomic-write";
import { getLotsWithRemaining, getAllInventoryTransactions, KEYS as IntakeKeys, newId } from "./intake-db";
import type { InventoryLotWithRemaining, InventoryTransaction } from "./intake-types";
import type { LiveState } from "./types";

// ---------------------------------------------------------------------
// Durable, scalable sale history + the atomic, optimistic-concurrency-
// protected Mark Sold write path.
//
// Storage: one small Redis key per SaleRecord (never a growing array
// rewritten on every sale), plus two sorted-set indexes (per-product,
// global) for audit/browsing, plus one small per-product aggregate key
// so Average Sale Price is an O(1) read (revenue / count), not a scan
// over every historical sale. SaleRecords are the permanent source of
// truth; the aggregate is written in the same atomic operation as
// everything else below, so it can never drift from the records that
// back it.
//
// Concurrency: two concurrent sales both reading inventory=4 must not
// both commit "3". markProductSold reads a lightweight per-product
// version counter (kv.ts: KEYS.productVersion) before computing
// anything, and the atomic script refuses to apply the write at all if
// that counter has moved since — a real compare-and-swap, independent of
// whether the client's button happened to be disabled.
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
  price: number;
  soldAt: string;
  status: SaleRecordStatus;
  lotId: string | null;
  landedCostAtSale: number | null;
}

interface SalesAggregate {
  completedSaleCount: number;
  completedSalesRevenue: number;
}

const ZERO_AGGREGATE: SalesAggregate = { completedSaleCount: 0, completedSalesRevenue: 0 };

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

async function getSalesAggregate(productId: string): Promise<SalesAggregate> {
  return (await redis.get<SalesAggregate>(aggregateKey(productId))) ?? ZERO_AGGREGATE;
}

/** Reads only the small aggregate key — never scans SaleRecords. */
export async function computeAverageSalePrice(
  productId: string
): Promise<{ averageSalePrice: number | null; saleCount: number }> {
  const agg = await getSalesAggregate(productId);
  if (agg.completedSaleCount === 0) return { averageSalePrice: null, saleCount: 0 };
  return { averageSalePrice: agg.completedSalesRevenue / agg.completedSaleCount, saleCount: agg.completedSaleCount };
}

/** Pages the per-product sorted-set index, newest first — the audit
 *  trail view. Never loads sales outside the requested page. */
export async function getSaleRecordsForProduct(productId: string, limit = 50): Promise<SaleRecord[]> {
  const ids = (await redis.zrange(byProductZsetKey(productId), 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => redis.get<SaleRecord>(saleKey(id))));
  return records.filter((r): r is SaleRecord => r !== null);
}

export async function getSaleRecordById(saleId: string): Promise<SaleRecord | null> {
  return (await redis.get<SaleRecord>(saleKey(saleId))) ?? null;
}

/** Oldest lot (by receivedDate) with stock actually remaining — pure
 *  read, FIFO by construction since getLotsWithRemaining already sorts
 *  oldest-first. Replaces the old consumeFromOldestLot, which used to
 *  also write the transaction itself as a separate, non-atomic step. */
export async function findOldestLotWithStock(productId: string): Promise<InventoryLotWithRemaining | null> {
  const lots = await getLotsWithRemaining(productId);
  return lots.find((l) => l.remaining > 0) ?? null;
}

const MAX_RECENT_SALES = 25;
const MAX_CONFLICT_RETRIES = 3;

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
//
// Fully fixed-position, no loops, no dynamic indexing — this script is
// specific to Mark Sold's exact write shape, unlike the generic
// atomicWrite() in atomic-write.ts, so there's no need to generalize it.
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
      soldAt: sale.soldAt,
      status: "completed",
      lotId: lot?.id ?? null,
      landedCostAtSale,
    };

    const aggregate = await getSalesAggregate(product.id);
    const updatedAggregate: SalesAggregate = {
      completedSaleCount: aggregate.completedSaleCount + 1,
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
