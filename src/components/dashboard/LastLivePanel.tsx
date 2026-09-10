"use client";

import Link from "next/link";
import { Button } from "@/components/Button";
import { formatCurrency, formatDate, formatTime } from "@/lib/format";
import type { LiveSession, LiveSessionStats } from "@/lib/live-types";

interface ProductRef {
  id: string;
  brand: string;
  name: string;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className="text-lg font-semibold text-ld-white">{value}</p>
    </div>
  );
}

/** Always the most recently COMPLETED Live — independent of the
 *  dashboard's timeframe filter, and never the currently-active session
 *  (that's what the separate "Live Now" banner is for). */
export function LastLivePanel({
  session,
  stats,
  topProduct,
  activeSession,
}: {
  session: LiveSession | null;
  stats: LiveSessionStats | null;
  topProduct: ProductRef | null;
  activeSession: LiveSession | null;
}) {
  return (
    <div className="space-y-3">
      {activeSession && (
        <Link
          href="/golive"
          className="flex items-center gap-2 rounded-xl border border-ld-red/40 bg-ld-red/10 px-4 py-2.5 text-sm font-bold text-ld-red hover:bg-ld-red/15"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-ld-red" />
          Live Now — {activeSession.name} · Go to Go Live →
        </Link>
      )}

      <div className="glass-panel rounded-2xl p-6">
        <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">Last Live</p>

        {!session || !stats ? (
          <p className="mt-3 text-sm text-ld-muted">No completed Live Sessions yet.</p>
        ) : (
          <>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-2xl font-extrabold text-ld-white">{session.name}</h2>
              <Link href={`/golive/sessions/${session.id}`}>
                <Button variant="outline" size="md">
                  View Session
                </Button>
              </Link>
            </div>
            <p className="mb-4 text-xs text-ld-muted">
              {formatDate(session.startedAt)} · {formatTime(session.startedAt)}
            </p>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Duration" value={formatDuration(stats.liveTimeMs)} />
              <Stat label="Products Presented" value={String(stats.productsPresented)} />
              <Stat label="Units Sold" value={String(stats.unitsSold)} />
              <Stat label="Revenue" value={formatCurrency(stats.revenue)} />
              <Stat label="Cost" value={formatCurrency(stats.costOfGoods)} />
              <Stat label="Est. Gross Profit" value={stats.estimatedGrossProfit != null ? formatCurrency(stats.estimatedGrossProfit) : "—"} />
              <Stat label="Sell-Through" value={stats.presentationSellThrough != null ? `${Math.round(stats.presentationSellThrough * 100)}%` : "—"} />
              <Stat label="Top Product" value={topProduct ? `${topProduct.brand} ${topProduct.name}` : "—"} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
