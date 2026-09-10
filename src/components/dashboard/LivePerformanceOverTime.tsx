"use client";

import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/format";
import type { Timeframe } from "@/lib/dashboard-db";
import type { LiveSession, LiveSessionStats } from "@/lib/live-types";

const TIMEFRAMES: { key: Timeframe; label: string }[] = [
  { key: "7d", label: "7 Days" },
  { key: "30d", label: "30 Days" },
  { key: "90d", label: "90 Days" },
  { key: "all", label: "All Time" },
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="text-[10px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className="font-display text-lg font-extrabold text-ld-white">{value}</p>
    </div>
  );
}

export function LivePerformanceOverTime({
  timeframe,
  onTimeframeChange,
  sessions,
}: {
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  sessions: { session: LiveSession; stats: LiveSessionStats }[];
}) {
  const completed = sessions.filter((s) => s.session.status === "ended");
  const totalRevenue = completed.reduce((sum, s) => sum + s.stats.revenue, 0);
  const totalUnits = completed.reduce((sum, s) => sum + s.stats.unitsSold, 0);
  const avgUnitsPerLive = completed.length > 0 ? totalUnits / completed.length : null;
  const avgSellingPrice = totalUnits > 0 ? totalRevenue / totalUnits : null;
  const sellThroughValues = completed.map((s) => s.stats.presentationSellThrough).filter((v): v is number => v !== null);
  const avgSellThrough = sellThroughValues.length > 0 ? sellThroughValues.reduce((a, b) => a + b, 0) / sellThroughValues.length : null;

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Live Performance Over Time</h3>
        <div className="flex gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              onClick={() => onTimeframeChange(tf.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
                timeframe === tf.key ? "bg-ld-purple text-ld-white" : "bg-ld-bg-elevated text-ld-muted hover:text-ld-white"
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      {completed.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ld-border p-6 text-center text-sm text-ld-muted">
          No completed Live Sessions in this window.
        </p>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Lives" value={String(completed.length)} />
            <Stat label="Total Revenue" value={formatCurrency(totalRevenue)} />
            <Stat label="Avg Units / Live" value={avgUnitsPerLive != null ? avgUnitsPerLive.toFixed(1) : "—"} />
            <Stat label="Avg Selling Price" value={avgSellingPrice != null ? formatCurrency(avgSellingPrice) : "—"} />
            <Stat label="Avg Sell-Through" value={avgSellThrough != null ? `${Math.round(avgSellThrough * 100)}%` : "—"} />
          </div>

          <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {completed.map(({ session, stats }) => (
              <Link
                key={session.id}
                href={`/golive/sessions/${session.id}`}
                className="flex items-center justify-between rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-2.5 text-sm hover:border-ld-purple/50"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ld-white">{session.name}</p>
                  <p className="text-xs text-ld-muted">{formatDate(session.startedAt)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-4 text-xs">
                  <span className="font-bold text-ld-green">{formatCurrency(stats.revenue)}</span>
                  <span className="text-ld-white">{stats.unitsSold} units</span>
                  <span className="text-ld-muted">
                    {stats.presentationSellThrough != null ? `${Math.round(stats.presentationSellThrough * 100)}%` : "—"}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
