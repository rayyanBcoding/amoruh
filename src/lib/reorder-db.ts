import { getProducts } from "./db";
import { getPresentationsForSession, getRecentSessions } from "./live-db";
import { getProductOfferComparison } from "./pricing-db";
import {
  computeReorderIntelligence,
  drilldownForProduct,
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

export async function getReorderIntelligence(window: WindowKey): Promise<ReorderResult> {
  const [{ sessions, sales }, products] = await Promise.all([loadLiveHistory(), getProducts()]);
  return computeReorderIntelligence({
    sessions,
    sales,
    products: products.map((p) => ({ id: p.id, brand: p.brand, name: p.name, size: p.size, sku: p.sku, barcode: p.barcode, inventory: p.inventory })),
    window,
  });
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
    const cmp = await getProductOfferComparison(productId);
    const best = cmp.bestPrice;
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
): Promise<{ sessions: DrilldownSession[]; row: ReorderResult["rows"][number] | null; supplier: SupplierCostInfo | null }> {
  const [{ sessions, sales }, result] = await Promise.all([loadLiveHistory(), getReorderIntelligence(window)]);
  const row = result.rows.find((r) => r.productId === productId) ?? null;
  const supplier = row ? await getSupplierCostInfo(productId, row.avgSellingPrice) : null;
  return { sessions: drilldownForProduct({ productId, sessions, sales, window }), row, supplier };
}
