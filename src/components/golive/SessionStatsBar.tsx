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
  return (
    <div className="glass-panel grid grid-cols-3 gap-3 rounded-2xl p-4 sm:grid-cols-6">
      <Cell label="Live Time" value={formatDuration(stats.liveTimeMs)} />
      <Cell label="Presented" value={String(stats.productsPresented)} />
      <Cell label="Units Sold" value={String(stats.unitsSold)} />
      <Cell label="Revenue" value={formatCurrency(stats.revenue)} />
      <Cell label="Est. Profit" value={stats.estimatedGrossProfit != null ? formatCurrency(stats.estimatedGrossProfit) : "—"} />
      <Cell label="Sell-Through" value={stats.presentationSellThrough != null ? `${Math.round(stats.presentationSellThrough * 100)}%` : "—"} />
    </div>
  );
}
