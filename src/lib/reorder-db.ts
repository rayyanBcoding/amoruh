import { getProducts } from "./db";
import { getPresentationsForSession, getRecentSessions } from "./live-db";
import { getProductBestActionableOffer } from "./pricing-db";
import {
  applySupplierCosts,
  computeReorderIntelligence,
  drilldownForProduct,
  forwardLookingFor,
  type ForwardLooking,
  type DrilldownSession,
  type HistorySale,
  type HistorySession,
  type ReorderResult,
} from "./reorder-intelligence";
import type { WindowKey } from "./reorder-config";

// ---------------------------------------------------------------------
// Loader for LIVE Reorder Intelligence. SaleRecords stay the single source of
// truth: this reads every real Live's sales through the EXISTING session →
// presentations → sales indexes (batched MGETs, a handful of round trips for
// ~1,000 sales) and hands plain rows to the pure scorer. Nothing is stored.
// A cache/version layer can wrap loadLiveHistory() later without any change to
// the scoring code.
// ---------------------------------------------------------------------

export async function loadLiveHistory(): Promise<{ sessions: HistorySession[]; sales: HistorySale[] }> {
  const sessions = await getRecentSessions(1000);
  const perSession = await Promise.all(sessions.map((s) => getPresentationsForSession(s.id, 10_000)));
  const sales: HistorySale[] = [];
  perSession.forEach((views, i) => {
    for (const v of views) {
      const sale = v.sale;
      if (v.presentation.outcome !== "sold" || !sale) continue;
      sales.push({
        saleId: sale.id,
        sessionId: sessions[i].id,
        productId: sale.productId,
        quantity: sale.quantity ?? 1,
        price: sale.price,
        landedCostAtSale: sale.landedCostAtSale ?? null,
        soldAt: sale.soldAt,
        status: sale.status,
        liveOrderNumber: sale.liveOrderNumber ?? null,
      });
    }
  });
  return { sessions: sessions.map((s) => ({ id: s.id, name: s.name, startedAt: s.startedAt })), sales };
}

/** A supplier-cost lookup, injectable so the rule can be tested without a Pricing database. */
export type SupplierCostLookup = (productId: string) => Promise<{ costUsd: number | null; supplierName: string | null }>;

const realSupplierCostLookup: SupplierCostLookup = async (productId) => {
  const info = await getSupplierCostInfo(productId, 0);
  return { costUsd: info.bestSupplierCostUsd, supplierName: info.supplierName };
};

/** Historical scoring (pure) + forward-looking supplier guidance for the High Demand / Losing Money
 *  products only. The supplier lookups never touch the historical numbers or the score. */
export async function getReorderIntelligence(window: WindowKey, lookup: SupplierCostLookup | null = realSupplierCostLookup): Promise<ReorderResult> {
  const [{ sessions, sales }, products] = await Promise.all([loadLiveHistory(), getProducts()]);
  const result = computeReorderIntelligence({
    sessions,
    sales,
    products: products.map((p) => ({ id: p.id, brand: p.brand, name: p.name, size: p.size, sku: p.sku, barcode: p.barcode, inventory: p.inventory })),
    window,
  });
  if (lookup === null) return result; // historical-only: the fast first paint
  const losing = result.rows.filter((r) => r.bucket === "High Demand / Losing Money");
  const costs = new Map<string, { costUsd: number | null; supplierName: string | null }>();
  for (let i = 0; i < losing.length; i += 6) {
    const batch = losing.slice(i, i + 6);
    const found = await Promise.all(batch.map((r) => lookup(r.productId).catch(() => ({ costUsd: null, supplierName: null }))));
    batch.forEach((r, k) => costs.set(r.productId, found[k]));
  }
  return applySupplierCosts(result, costs);
}

export interface SupplierCostInfo {
  /** Current best ACTIONABLE supplier price in USD, from the Pricing / Ordering system; null when none. */
  bestSupplierCostUsd: number | null;
  supplierName: string | null;
  /** historical average selling price − current best supplier cost; forward-looking only */
  expectedProfitPerUnit: number | null;
}

/** Forward-looking only: never feeds back into historical cost/profit. */
export async function getSupplierCostInfo(productId: string, avgSellingPrice: number): Promise<SupplierCostInfo> {
  try {
    const best = await getProductBestActionableOffer(productId);
    if (!best || !best.priceUsdValid) return { bestSupplierCostUsd: null, supplierName: null, expectedProfitPerUnit: null };
    return {
      bestSupplierCostUsd: best.priceUsd,
      supplierName: best.supplierName,
      expectedProfitPerUnit: Math.round((avgSellingPrice - best.priceUsd) * 100) / 100,
    };
  } catch {
    return { bestSupplierCostUsd: null, supplierName: null, expectedProfitPerUnit: null };
  }
}

export async function getProductDrilldown(
  productId: string,
  window: WindowKey
): Promise<{ sessions: DrilldownSession[]; row: ReorderResult["rows"][number] | null; supplier: SupplierCostInfo | null; forward: ForwardLooking | null }> {
  const [{ sessions, sales }, result] = await Promise.all([loadLiveHistory(), getReorderIntelligence(window)]);
  const row = result.rows.find((r) => r.productId === productId) ?? null;
  const supplier = row ? await getSupplierCostInfo(productId, row.avgSellingPrice) : null;
  // any product can show the projection; it is guidance only and never changes a historical value
  const forward = row ? row.forward ?? forwardLookingFor(row, supplier?.bestSupplierCostUsd ?? null, supplier?.supplierName ?? null) : null;
  return { sessions: drilldownForProduct({ productId, sessions, sales, window }), row, supplier, forward };
}
