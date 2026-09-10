"use client";

import Link from "next/link";
import { formatCurrency } from "@/lib/format";
import type { InventorySummary, InventoryValuation, PurchasingSummary } from "@/lib/dashboard-db";
import type { LiveSessionStats } from "@/lib/live-types";

function Card({
  label,
  value,
  accent,
  sub,
  href,
}: {
  label: string;
  value: string | number;
  accent?: string;
  sub?: string;
  href?: string;
}) {
  const inner = (
    <div className="glass-panel h-full rounded-2xl p-5">
      <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className={`mt-1 font-display text-3xl font-extrabold ${accent ?? "text-ld-white"}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-ld-muted">{sub}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block transition-transform hover:-translate-y-0.5">
      {inner}
    </Link>
  ) : (
    inner
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-ld-muted">{children}</p>;
}

export function InventorySummaryCards({ inventory, valuation }: { inventory: InventorySummary; valuation: InventoryValuation }) {
  return (
    <div>
      <GroupLabel>Current Inventory</GroupLabel>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card label="Total Units" value={inventory.totalUnits.toLocaleString()} />
        <Card
          label="Inventory Cost Value"
          value={formatCurrency(valuation.totalValue)}
          sub={valuation.skusMissingCost > 0 ? `${valuation.skusMissingCost} SKU${valuation.skusMissingCost === 1 ? "" : "s"} missing cost` : undefined}
        />
        <Card label="Active SKUs" value={inventory.activeSkus.toLocaleString()} />
        <Card
          label="Low Stock"
          value={inventory.lowStockCount}
          accent={inventory.lowStockCount > 0 ? "text-ld-amber" : undefined}
          href="/inventory?filter=low_stock"
        />
        <Card
          label="Out of Stock"
          value={inventory.outOfStockCount}
          accent={inventory.outOfStockCount > 0 ? "text-ld-red" : undefined}
          href="/inventory?filter=sold_out"
        />
      </div>
    </div>
  );
}

export function LivePerformanceSummaryCards({ stats }: { stats: LiveSessionStats | null }) {
  return (
    <div>
      <GroupLabel>Live Performance (Last Live)</GroupLabel>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card label="Revenue" value={stats ? formatCurrency(stats.revenue) : "—"} accent="text-ld-green" />
        <Card label="Units Sold" value={stats ? stats.unitsSold : "—"} />
        <Card label="Gross Profit" value={stats?.estimatedGrossProfit != null ? formatCurrency(stats.estimatedGrossProfit) : "—"} />
        <Card label="Sell-Through" value={stats?.presentationSellThrough != null ? `${Math.round(stats.presentationSellThrough * 100)}%` : "—"} />
        <Card label="No Sales" value={stats ? stats.noSaleCount : "—"} />
      </div>
    </div>
  );
}

export function PurchasingSummaryCards({ purchasing }: { purchasing: PurchasingSummary }) {
  return (
    <div>
      <GroupLabel>Purchasing / Incoming</GroupLabel>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card label="Open Orders" value={purchasing.openOrders} href="/intake" />
        <Card label="Incoming Units" value={purchasing.incomingUnits.toLocaleString()} />
        <Card label="Recently Received" value={purchasing.recentlyReceived.length} href="/intake" />
      </div>
    </div>
  );
}
