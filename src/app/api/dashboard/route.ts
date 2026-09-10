import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import {
  getDashboardData,
  type ActivityItem,
  type InventorySummary,
  type InventoryValuation,
  type LowStockItem,
  type ProductLivePerformance,
  type PurchasingSummary,
  type ReorderCandidate,
  type Timeframe,
} from "@/lib/dashboard-db";
import type { LiveSession, LiveSessionStats } from "@/lib/live-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TIMEFRAMES: Timeframe[] = ["7d", "30d", "90d", "all"];

export interface DashboardProductRef {
  id: string;
  sku: string;
  brand: string;
  name: string;
  image: string;
  color: string;
}

type WithProduct<T> = T & { product: DashboardProductRef | null };

/** The exact shape GET /api/dashboard returns — imported as a type by
 *  the dashboard page so its state stays real, not `any`. */
export interface DashboardApiResponse {
  timeframe: Timeframe;
  inventory: InventorySummary;
  inventoryValuation: InventoryValuation;
  activeSession: LiveSession | null;
  lastCompletedSession: { session: LiveSession; stats: LiveSessionStats; topProduct: DashboardProductRef | null } | null;
  sessionsInRange: { session: LiveSession; stats: LiveSessionStats }[];
  topSellers: WithProduct<ProductLivePerformance>[];
  highestSellThrough: WithProduct<ProductLivePerformance>[];
  mostProfitable: WithProduct<ProductLivePerformance>[];
  productsToWatch: WithProduct<ProductLivePerformance>[];
  reorderCandidates: WithProduct<ReorderCandidate>[];
  lowStockItems: WithProduct<LowStockItem>[];
  purchasing: PurchasingSummary;
  recentActivity: ActivityItem[];
}

async function resolveProducts(ids: string[]): Promise<Map<string, DashboardProductRef>> {
  const unique = Array.from(new Set(ids));
  const products = await Promise.all(unique.map((id) => getProduct(id)));
  const map = new Map<string, DashboardProductRef>();
  products.forEach((p, i) => {
    if (p) map.set(unique[i], { id: p.id, sku: p.sku, brand: p.brand, name: p.name, image: p.image, color: p.color });
  });
  return map;
}

function withProduct<T extends { productId: string }>(rows: T[], productById: Map<string, DashboardProductRef>): WithProduct<T>[] {
  return rows.map((row) => ({ ...row, product: productById.get(row.productId) ?? null }));
}

// GET /api/dashboard?timeframe=7d|30d|90d|all — the analytics command
// center's single composite endpoint. Everything is derived live from
// Go Live's data (LiveSession/LivePresentation/SaleRecord) plus the
// existing Product/InventoryLot/PurchaseOrder/Pricing-Ordering data — see
// src/lib/dashboard-db.ts, which does the actual aggregation; this route
// only resolves display info (brand/name/image) for the product ids that
// come back.
export async function GET(req: Request) {
  try {
    const timeframeParam = new URL(req.url).searchParams.get("timeframe");
    const timeframe: Timeframe = VALID_TIMEFRAMES.includes(timeframeParam as Timeframe)
      ? (timeframeParam as Timeframe)
      : "30d";

    const data = await getDashboardData(timeframe);

    const allProductIds = [
      ...data.topSellers.map((p) => p.productId),
      ...data.highestSellThrough.map((p) => p.productId),
      ...data.mostProfitable.map((p) => p.productId),
      ...data.productsToWatch.map((p) => p.productId),
      ...data.reorderCandidates.map((c) => c.productId),
      ...data.lowStockItems.map((i) => i.productId),
      ...(data.lastCompletedSession?.stats.topProductId ? [data.lastCompletedSession.stats.topProductId] : []),
    ];
    const productById = await resolveProducts(allProductIds);

    const response: DashboardApiResponse = {
      timeframe: data.timeframe,
      inventory: data.inventory,
      inventoryValuation: data.inventoryValuation,
      activeSession: data.activeSession,
      lastCompletedSession: data.lastCompletedSession
        ? {
            session: data.lastCompletedSession.session,
            stats: data.lastCompletedSession.stats,
            topProduct: data.lastCompletedSession.stats.topProductId
              ? productById.get(data.lastCompletedSession.stats.topProductId) ?? null
              : null,
          }
        : null,
      sessionsInRange: data.sessionsInRange,
      topSellers: withProduct<ProductLivePerformance>(data.topSellers, productById),
      highestSellThrough: withProduct<ProductLivePerformance>(data.highestSellThrough, productById),
      mostProfitable: withProduct<ProductLivePerformance>(data.mostProfitable, productById),
      productsToWatch: withProduct<ProductLivePerformance>(data.productsToWatch, productById),
      reorderCandidates: withProduct<ReorderCandidate>(data.reorderCandidates, productById),
      lowStockItems: withProduct<LowStockItem>(data.lowStockItems, productById),
      purchasing: data.purchasing,
      recentActivity: data.recentActivity,
    };
    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load dashboard data: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
