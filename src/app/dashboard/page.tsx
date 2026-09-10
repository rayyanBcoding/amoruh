"use client";

import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import type { Timeframe } from "@/lib/dashboard-db";
import type { DashboardApiResponse } from "@/app/api/dashboard/route";
import { InventorySummaryCards, LivePerformanceSummaryCards, PurchasingSummaryCards } from "@/components/dashboard/SummaryCards";
import { LastLivePanel } from "@/components/dashboard/LastLivePanel";
import { LivePerformanceOverTime } from "@/components/dashboard/LivePerformanceOverTime";
import {
  HighestSellThroughTable,
  MostProfitableTable,
  ProductsToWatchTable,
  TopSellersTable,
} from "@/components/dashboard/TopProductsSection";
import { InventoryAttention } from "@/components/dashboard/InventoryAttention";
import { ReorderIntelligence } from "@/components/dashboard/ReorderIntelligence";
import { RecentActivityFeed } from "@/components/dashboard/RecentActivityFeed";

// The analytics command center — everything here is read-only, derived
// live from Go Live's data (LiveSession/LivePresentation/SaleRecord) and
// the existing Product/Inventory/Purchasing/Pricing-Ordering data. See
// src/lib/dashboard-db.ts for the aggregation and src/app/api/dashboard/
// route.ts for the composite endpoint this page calls.
export default function DashboardPage() {
  const [timeframe, setTimeframe] = useState<Timeframe>("30d");
  const [data, setData] = useState<DashboardApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (tf: Timeframe) => {
    try {
      const res = await fetch(`/api/dashboard?timeframe=${tf}`, { cache: "no-store" });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Could not load dashboard data.");
        return;
      }
      setError(null);
      setData(payload);
    } catch {
      setError("Network error — is the server running?");
    }
  }, []);

  useEffect(() => {
    // Deferred a tick — react-hooks/set-state-in-effect flags any direct
    // call, from an effect body, to a function that can set state;
    // queuing the call as a microtask keeps the load-on-timeframe-change
    // behavior working without that violation (same pattern used
    // elsewhere in this codebase, e.g. match-review/page.tsx).
    Promise.resolve().then(() => {
      void load(timeframe);
    });
  }, [load, timeframe]);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1600px] space-y-6 px-6 py-6">
        <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">Dashboard</h1>

        {error && <div className="rounded-xl border border-ld-red/40 bg-ld-red/10 px-4 py-3 text-sm font-medium text-ld-red">{error}</div>}

        {!data ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <p className="animate-pulse text-ld-muted">Loading dashboard…</p>
          </div>
        ) : (
          <>
            <div className="space-y-5">
              <InventorySummaryCards inventory={data.inventory} valuation={data.inventoryValuation} />
              <LivePerformanceSummaryCards stats={data.lastCompletedSession?.stats ?? null} />
              <PurchasingSummaryCards purchasing={data.purchasing} />
            </div>

            <LastLivePanel
              session={data.lastCompletedSession?.session ?? null}
              stats={data.lastCompletedSession?.stats ?? null}
              topProduct={data.lastCompletedSession?.topProduct ?? null}
              activeSession={data.activeSession}
            />

            <LivePerformanceOverTime timeframe={timeframe} onTimeframeChange={setTimeframe} sessions={data.sessionsInRange} />

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <TopSellersTable rows={data.topSellers} />
              <HighestSellThroughTable rows={data.highestSellThrough} />
              <MostProfitableTable rows={data.mostProfitable} />
              <ProductsToWatchTable rows={data.productsToWatch} />
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
              <InventoryAttention rows={data.lowStockItems} />
              <ReorderIntelligence rows={data.reorderCandidates} />
              <RecentActivityFeed items={data.recentActivity} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
