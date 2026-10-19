"use client";

import type { LiveSessionStats } from "@/lib/live-types";
import { formatCurrency } from "@/lib/format";

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="text-[10px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className="font-display text-lg font-extrabold text-ld-white">{value}</p>
    </div>
  );
}

/** Lightweight — this deliberately does NOT try to be the analytics
 *  screen (that's Dashboard, Pass B). Just enough to glance at without
 *  distracting from the product/action area. */
export function SessionStatsBar({ stats }: { stats: LiveSessionStats }) {
  // The Live Order Ledger fields exist for real Lives; Test Live stats predate them.
  const ledger = stats.enteredOrders !== undefined;
  return (
    <div className="glass-panel space-y-3 rounded-2xl p-4">
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <Cell label="Live Time" value={formatDuration(stats.liveTimeMs)} />
        <Cell label="Presented" value={String(stats.productsPresented)} />
        <Cell label="Units Sold" value={String(stats.unitsSold)} />
        <Cell label={ledger ? "GMV" : "Revenue"} value={formatCurrency(stats.revenue)} />
        <Cell
          label={ledger ? "Gross Profit" : "Est. Profit"}
          value={stats.estimatedGrossProfit != null ? formatCurrency(stats.estimatedGrossProfit) : "—"}
        />
        <Cell label="Sell-Through" value={stats.presentationSellThrough != null ? `${Math.round(stats.presentationSellThrough * 100)}%` : "—"} />
      </div>
      {ledger && (
        <div className="grid grid-cols-3 gap-3 border-t border-ld-border/60 pt-3 sm:grid-cols-6">
          <Cell label="Total Entered" value={String(stats.enteredOrders)} />
          <Cell label="Active Orders" value={String(stats.activeOrders ?? 0)} />
          <Cell label="Canceled" value={String(stats.canceledOrders ?? 0)} />
          <Cell label="Merchandise Cost" value={stats.estimatedGrossProfit != null ? formatCurrency(stats.costOfGoods) : "—"} />
          <Cell label="Gross Margin" value={stats.grossMargin != null ? `${(stats.grossMargin * 100).toFixed(1)}%` : "—"} />
          <Cell label="Missing Cost" value={String(stats.ordersMissingCost ?? 0)} />
        </div>
      )}
    </div>
  );
}
