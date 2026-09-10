import { getProducts } from "./db";
import type { Product } from "./types";
import { getAllReceivingEvents, getLandedCostByProduct, getPOs, getSuppliers } from "./intake-db";
import type { PurchaseOrder, ReceivingEvent } from "./intake-types";
import {
  getActiveSession,
  getLastCompletedSession,
  getPresentationsForSession,
  getRecentSessions,
  getSessionStats,
  isEffectivelySold,
} from "./live-db";
import type { LiveSession, LiveSessionStats } from "./live-types";
import { getRecentUploads } from "./pricing-db";
import { formatCurrency } from "./format";

// ---------------------------------------------------------------------
// Dashboard's aggregation layer. Every function here is a pure READ,
// computed live from Pass A's Live data (LiveSession/LivePresentation/
// SaleRecord) plus the existing Product/InventoryLot/PurchaseOrder/
// Pricing-Ordering data — nothing here is a stored, cacheable total that
// could drift from the records that back it (guardrail #14 of the
// approved Go Live plan, carried forward here). At this business's real
// scale (a handful of Live sessions a week, dozens–low-hundreds of
// presentations each) recomputing on every dashboard load is well within
// budget; a future pass can add caching if that ever stops being true —
// nothing here needs to change shape to support that later.
// ---------------------------------------------------------------------

export type Timeframe = "7d" | "30d" | "90d" | "all";

const LOW_STOCK_THRESHOLD = 3;
const MIN_SAMPLE_FOR_SELL_THROUGH = 5; // Highest Sell-Through's floor — same as Products to Watch
const WATCH_MIN_PRESENTED = 5;
const WATCH_MAX_SELL_THROUGH = 0.4;
const REORDER_MIN_SELL_THROUGH = 0.6;

function timeframeCutoffISO(timeframe: Timeframe): string | null {
  if (timeframe === "all") return null;
  const days = timeframe === "7d" ? 7 : timeframe === "30d" ? 30 : 90;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------
// Live product performance — the one real new aggregation this pass
// needs. Rolls LivePresentation + linked SaleRecord data up by product,
// across every session in the timeframe. Feeds Top Sellers / Highest
// Sell-Through / Most Profitable / Products to Watch / Reorder
// Intelligence — one aggregation, several views, no duplicated logic.
// ---------------------------------------------------------------------

export interface ProductLivePerformance {
  productId: string;
  /** Total presentation events — can exceed distinctSessionsPresentedIn
   *  if a product was shown more than once in the same Live. */
  timesPresented: number;
  /** Lives this product actually appeared in — incremented once per
   *  session, never once per presentation. */
  distinctSessionsPresentedIn: number;
  timesSold: number;
  timesNoSale: number;
  unitsSold: number;
  revenue: number;
  /** null when any contributing sale lacks a recorded landed cost. */
  costOfGoods: number | null;
  grossProfit: number | null;
  /** timesSold / (timesSold + timesNoSale) — a canceled sale's
   *  presentation contributes to neither bucket (see isEffectivelySold). */
  sellThrough: number | null;
  averageAuction: number | null;
  averageProfitPerUnit: number | null;
  /** unitsSold / distinctSessionsPresentedIn — NEVER unitsSold /
   *  timesPresented. This is the number Reorder Intelligence uses. */
  averageUnitsPerLivePresented: number | null;
}

interface ProductAccumulator {
  timesPresented: number;
  sessionsSet: Set<string>;
  timesSold: number;
  timesNoSale: number;
  unitsSold: number;
  revenue: number;
  costSum: number;
  costMissingOnASale: boolean;
}

export async function getLiveProductPerformance(sinceISO: string | null): Promise<ProductLivePerformance[]> {
  const sessions = await getRecentSessions(500);
  const inRange = sessions.filter((s) => !sinceISO || s.startedAt >= sinceISO);
  const viewsBySession = await Promise.all(inRange.map((s) => getPresentationsForSession(s.id, 2000)));

  const byProduct = new Map<string, ProductAccumulator>();

  for (let i = 0; i < inRange.length; i++) {
    const sessionId = inRange[i].id;
    for (const view of viewsBySession[i]) {
      const productId = view.presentation.productId;
      let acc = byProduct.get(productId);
      if (!acc) {
        acc = {
          timesPresented: 0,
          sessionsSet: new Set(),
          timesSold: 0,
          timesNoSale: 0,
          unitsSold: 0,
          revenue: 0,
          costSum: 0,
          costMissingOnASale: false,
        };
        byProduct.set(productId, acc);
      }
      acc.timesPresented += 1;
      acc.sessionsSet.add(sessionId);

      if (view.presentation.outcome === "no_sale") {
        acc.timesNoSale += 1;
      } else if (isEffectivelySold(view) && view.sale) {
        acc.timesSold += 1;
        acc.unitsSold += view.sale.quantity;
        acc.revenue += view.sale.price;
        if (view.sale.landedCostAtSale !== null) {
          acc.costSum += view.sale.landedCostAtSale * view.sale.quantity;
        } else {
          acc.costMissingOnASale = true;
        }
      }
      // A "sold" presentation whose sale was later canceled falls into
      // neither bucket — matches isEffectivelySold's semantics: treated
      // as if the auction attempt itself never resolved, not fabricated
      // as a "no sale."
    }
  }

  const result: ProductLivePerformance[] = [];
  for (const [productId, acc] of byProduct) {
    const completed = acc.timesSold + acc.timesNoSale;
    const costOfGoods = acc.timesSold > 0 && !acc.costMissingOnASale ? acc.costSum : null;
    const grossProfit = costOfGoods !== null ? acc.revenue - costOfGoods : null;
    const distinctSessions = acc.sessionsSet.size;
    result.push({
      productId,
      timesPresented: acc.timesPresented,
      distinctSessionsPresentedIn: distinctSessions,
      timesSold: acc.timesSold,
      timesNoSale: acc.timesNoSale,
      unitsSold: acc.unitsSold,
      revenue: acc.revenue,
      costOfGoods,
      grossProfit,
      sellThrough: completed > 0 ? acc.timesSold / completed : null,
      averageAuction: acc.timesSold > 0 ? acc.revenue / acc.timesSold : null,
      averageProfitPerUnit: grossProfit !== null && acc.unitsSold > 0 ? grossProfit / acc.unitsSold : null,
      averageUnitsPerLivePresented: distinctSessions > 0 ? acc.unitsSold / distinctSessions : null,
    });
  }
  return result;
}

export function topSellersOf(performance: ProductLivePerformance[], limit = 10): ProductLivePerformance[] {
  return [...performance].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

export function highestSellThroughOf(performance: ProductLivePerformance[], limit = 10): ProductLivePerformance[] {
  return performance
    .filter((p) => p.timesPresented >= MIN_SAMPLE_FOR_SELL_THROUGH && p.sellThrough !== null)
    .sort((a, b) => (b.sellThrough as number) - (a.sellThrough as number))
    .slice(0, limit);
}

export function mostProfitableOf(performance: ProductLivePerformance[], limit = 10): ProductLivePerformance[] {
  return performance
    .filter((p) => p.grossProfit !== null)
    .sort((a, b) => (b.grossProfit as number) - (a.grossProfit as number))
    .slice(0, limit);
}

export function productsToWatchOf(performance: ProductLivePerformance[]): ProductLivePerformance[] {
  return performance
    .filter((p) => p.timesPresented >= WATCH_MIN_PRESENTED && p.sellThrough !== null && p.sellThrough < WATCH_MAX_SELL_THROUGH)
    .sort((a, b) => (a.sellThrough as number) - (b.sellThrough as number));
}

// ---------------------------------------------------------------------
// Reorder Intelligence — informational only. Never creates a PO; just a
// computed signal plus a link into the real Pricing/Ordering page.
// ---------------------------------------------------------------------

export interface ReorderCandidate {
  productId: string;
  currentInventory: number;
  averageUnitsPerLivePresented: number;
  sellThrough: number;
}

export function getReorderCandidates(products: Product[], performance: ProductLivePerformance[]): ReorderCandidate[] {
  const perfByProduct = new Map(performance.map((p) => [p.productId, p]));
  const candidates: ReorderCandidate[] = [];
  for (const product of products) {
    const perf = perfByProduct.get(product.id);
    if (!perf || perf.averageUnitsPerLivePresented === null || perf.sellThrough === null) continue;
    if (product.inventory < perf.averageUnitsPerLivePresented && perf.sellThrough >= REORDER_MIN_SELL_THROUGH) {
      candidates.push({
        productId: product.id,
        currentInventory: product.inventory,
        averageUnitsPerLivePresented: perf.averageUnitsPerLivePresented,
        sellThrough: perf.sellThrough,
      });
    }
  }
  return candidates.sort((a, b) => b.sellThrough - a.sellThrough);
}

// ---------------------------------------------------------------------
// Inventory summary + lot-accurate valuation
// ---------------------------------------------------------------------

export interface InventorySummary {
  totalUnits: number;
  activeSkus: number;
  lowStockCount: number;
  outOfStockCount: number;
}

export function getInventorySummary(products: Product[]): InventorySummary {
  let totalUnits = 0;
  let activeSkus = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  for (const p of products) {
    if (p.status === "archived") continue;
    totalUnits += p.inventory;
    activeSkus += 1;
    if (p.inventory === 0) outOfStockCount += 1;
    else if (p.inventory <= LOW_STOCK_THRESHOLD) lowStockCount += 1;
  }
  return { totalUnits, activeSkus, lowStockCount, outOfStockCount };
}

export interface LowStockItem {
  productId: string;
  inventory: number;
}

/** Lowest-stock-first, out-of-stock excluded (that's its own, more
 *  urgent bucket) — the actual rows for the Inventory Attention card,
 *  not just a count. */
export function getLowStockItems(products: Product[], limit = 10): LowStockItem[] {
  return products
    .filter((p) => p.status !== "archived" && p.inventory > 0 && p.inventory <= LOW_STOCK_THRESHOLD)
    .sort((a, b) => a.inventory - b.inventory)
    .slice(0, limit)
    .map((p) => ({ productId: p.id, inventory: p.inventory }));
}

export interface InventoryValuation {
  /** Confidently-priced value only — a SKU counted in skusMissingCost
   *  never silently contributes $0 to this total; it's excluded. */
  totalValue: number;
  valueFromLots: number;
  valueFromLegacyCost: number;
  skusValuedFromLots: number;
  skusValuedFromLegacyCost: number;
  skusMissingCost: number;
}

/** Σ(lot.remaining × lot.cost.landed) per product — NOT
 *  `Product.inventory × weighted average`, which can disagree with the
 *  lot ledger. A product with no lot data falls back to
 *  `Product.cost × Product.inventory`, tracked separately. A product
 *  with inventory but no reliable cost anywhere is excluded from
 *  totalValue and counted in skusMissingCost instead of being priced
 *  at $0. */
export async function getInventoryValuation(products: Product[]): Promise<InventoryValuation> {
  const landedByProduct = await getLandedCostByProduct();
  let valueFromLots = 0;
  let valueFromLegacyCost = 0;
  let skusValuedFromLots = 0;
  let skusValuedFromLegacyCost = 0;
  let skusMissingCost = 0;

  for (const p of products) {
    if (p.status === "archived" || p.inventory <= 0) continue;
    const lotEntry = landedByProduct[p.id];
    if (lotEntry) {
      valueFromLots += lotEntry.totalRemainingValue;
      skusValuedFromLots += 1;
    } else if (p.cost > 0) {
      valueFromLegacyCost += p.cost * p.inventory;
      skusValuedFromLegacyCost += 1;
    } else {
      skusMissingCost += 1;
    }
  }

  return {
    totalValue: valueFromLots + valueFromLegacyCost,
    valueFromLots,
    valueFromLegacyCost,
    skusValuedFromLots,
    skusValuedFromLegacyCost,
    skusMissingCost,
  };
}

// ---------------------------------------------------------------------
// Purchasing / Incoming
// ---------------------------------------------------------------------

export interface PurchasingSummary {
  openOrders: number;
  incomingUnits: number;
  recentlyReceived: { po: PurchaseOrder; receivedAt: string }[];
}

export async function getPurchasingSummary(limit = 5): Promise<PurchasingSummary> {
  const [pos, events] = await Promise.all([getPOs(), getAllReceivingEvents()]);

  const openOrders = pos.filter((p) => p.status === "awaiting_delivery" || p.status === "partially_received");
  const incomingUnits = openOrders.reduce((sum, p) => sum + Math.max(0, p.totalExpectedQty - p.totalReceivedQty), 0);

  const lastEventByPO = new Map<string, ReceivingEvent>();
  for (const e of events) {
    const existing = lastEventByPO.get(e.poId);
    if (!existing || e.timestamp > existing.timestamp) lastEventByPO.set(e.poId, e);
  }

  const recentlyReceived = pos
    .filter((p) => p.status === "received" || p.status === "closed")
    .map((p) => ({ po: p, event: lastEventByPO.get(p.id) ?? null }))
    .filter((x): x is { po: PurchaseOrder; event: ReceivingEvent } => x.event !== null)
    .sort((a, b) => b.event.timestamp.localeCompare(a.event.timestamp))
    .slice(0, limit)
    .map((x) => ({ po: x.po, receivedAt: x.event.timestamp }));

  return { openOrders: openOrders.length, incomingUnits, recentlyReceived };
}

// ---------------------------------------------------------------------
// Recent Activity — a live merge of real, already-timestamped events.
// No new event-logging system, and never a stronger label than what
// actually happened (a partial receipt is never worded like a
// completion; a canceled sale is never shown at all, since it's excluded
// upstream by isEffectivelySold).
// ---------------------------------------------------------------------

export interface ActivityItem {
  timestamp: string;
  text: string;
  href: string | null;
}

export async function getRecentActivity(limit = 20): Promise<ActivityItem[]> {
  const [sessions, uploads, pos, events, suppliers, products] = await Promise.all([
    getRecentSessions(20),
    getRecentUploads(20),
    getPOs(),
    getAllReceivingEvents(),
    getSuppliers(),
    getProducts(),
  ]);

  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const poById = new Map(pos.map((p) => [p.id, p]));

  const items: ActivityItem[] = [];

  for (const s of sessions) {
    items.push({ timestamp: s.startedAt, text: `Live Session started — ${s.name}`, href: `/golive/sessions/${s.id}` });
  }

  for (const u of uploads) {
    const supplierName = supplierById.get(u.supplierId)?.name ?? "a supplier";
    items.push({
      timestamp: u.startedAt,
      text: `Supplier price sheet uploaded — ${supplierName} (${u.filename})`,
      href: `/pricing/suppliers/${u.supplierId}`,
    });
  }

  // Receiving activity — one row per PO (its most recent event only),
  // worded from that PO's CURRENT status, never inferred as "completed"
  // unless the PO's own status actually says so.
  const lastEventByPO = new Map<string, ReceivingEvent>();
  for (const e of events) {
    const existing = lastEventByPO.get(e.poId);
    if (!existing || e.timestamp > existing.timestamp) lastEventByPO.set(e.poId, e);
  }
  for (const [poId, event] of lastEventByPO) {
    const po = poById.get(poId);
    if (!po) continue;
    let text: string;
    if (po.status === "received" || po.status === "closed") {
      text = `Order ${po.poNumber} receiving completed`;
    } else if (event.type === "not_received") {
      text = `Order ${po.poNumber} — items reported not received`;
    } else if (event.type === "unexpected") {
      text = `Order ${po.poNumber} — unexpected item received`;
    } else {
      text = `Order ${po.poNumber} — ${event.actualQty} units received`;
    }
    items.push({ timestamp: event.timestamp, text, href: `/intake/${poId}` });
  }

  // Sales — only effectively-sold presentations (a canceled sale is
  // excluded entirely, never shown then contradicted) from recent
  // sessions.
  const recentViews = (await Promise.all(sessions.slice(0, 10).map((s) => getPresentationsForSession(s.id, 50)))).flat();
  for (const view of recentViews) {
    if (isEffectivelySold(view) && view.sale) {
      const product = productById.get(view.presentation.productId);
      const label = product ? `${product.brand} ${product.name}` : view.presentation.sku;
      const correctedSuffix = view.sale.originalPrice != null ? " (corrected)" : "";
      items.push({
        timestamp: view.presentation.timestamp,
        text: `${label} sold — ${formatCurrency(view.sale.price)}${correctedSuffix}`,
        href: `/inventory/${view.presentation.productId}`,
      });
    }
  }

  return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

// ---------------------------------------------------------------------
// Composite — everything the Dashboard page needs in one call.
// ---------------------------------------------------------------------

export interface DashboardData {
  timeframe: Timeframe;
  inventory: InventorySummary;
  inventoryValuation: InventoryValuation;
  lowStockItems: LowStockItem[];
  activeSession: LiveSession | null;
  lastCompletedSession: { session: LiveSession; stats: LiveSessionStats } | null;
  sessionsInRange: { session: LiveSession; stats: LiveSessionStats }[];
  topSellers: ProductLivePerformance[];
  highestSellThrough: ProductLivePerformance[];
  mostProfitable: ProductLivePerformance[];
  productsToWatch: ProductLivePerformance[];
  reorderCandidates: ReorderCandidate[];
  purchasing: PurchasingSummary;
  recentActivity: ActivityItem[];
}

export async function getDashboardData(timeframe: Timeframe): Promise<DashboardData> {
  const sinceISO = timeframeCutoffISO(timeframe);

  const [products, performance, activeSession, lastCompleted, sessions, purchasing, recentActivity] = await Promise.all([
    getProducts(),
    getLiveProductPerformance(sinceISO),
    getActiveSession(),
    getLastCompletedSession(), // deliberately NOT filtered by sinceISO — see the approved plan
    getRecentSessions(50),
    getPurchasingSummary(),
    getRecentActivity(20),
  ]);

  const inventory = getInventorySummary(products);
  const inventoryValuation = await getInventoryValuation(products);

  const sessionsInRange = sessions.filter((s) => !sinceISO || s.startedAt >= sinceISO);
  const sessionsInRangeWithStats = await Promise.all(
    sessionsInRange.map(async (session) => ({ session, stats: await getSessionStats(session.id) }))
  );
  const lastCompletedSession = lastCompleted ? { session: lastCompleted, stats: await getSessionStats(lastCompleted.id) } : null;

  return {
    timeframe,
    inventory,
    inventoryValuation,
    lowStockItems: getLowStockItems(products),
    activeSession,
    lastCompletedSession,
    sessionsInRange: sessionsInRangeWithStats,
    topSellers: topSellersOf(performance),
    highestSellThrough: highestSellThroughOf(performance),
    mostProfitable: mostProfitableOf(performance),
    productsToWatch: productsToWatchOf(performance),
    reorderCandidates: getReorderCandidates(products, performance),
    purchasing,
    recentActivity,
  };
}
