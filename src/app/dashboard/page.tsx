"use client";

import { Nav } from "@/components/Nav";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { CurrentProductCard } from "@/components/dashboard/CurrentProductCard";
import { QueuePanel } from "@/components/dashboard/QueuePanel";
import { SearchProduct } from "@/components/dashboard/SearchProduct";
import { RecentSales } from "@/components/dashboard/RecentSales";
import { useLiveState } from "@/context/LiveStateContext";

export default function DashboardPage() {
  const { snapshot, loading, lastError } = useLiveState();

  return (
    <div className="min-h-screen">
      <Nav />

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-extrabold text-white lg:text-3xl">
              Operator Dashboard
            </h1>
            <p className="text-sm text-ld-muted">
              Scan a barcode to change what&apos;s live — everything below updates instantly.
            </p>
          </div>
        </div>

        {lastError && (
          <div className="mb-4 rounded-xl border border-ld-red/40 bg-ld-red/10 px-4 py-3 text-sm font-medium text-ld-red">
            {lastError}
          </div>
        )}

        {loading || !snapshot ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <p className="animate-pulse text-ld-muted">Connecting to Loot Depot OS…</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_380px]">
            <div className="space-y-6">
              <div className="glass-panel rounded-2xl p-5">
                <BarcodeScanner />
              </div>
              <CurrentProductCard snapshot={snapshot} />
            </div>

            <div className="space-y-6">
              <QueuePanel queue={snapshot.queue} />
              <SearchProduct products={snapshot.allProducts} />
              <RecentSales sales={snapshot.recentSales} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
