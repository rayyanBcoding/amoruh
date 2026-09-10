"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Nav } from "@/components/Nav";
import { BottleImage } from "@/components/BottleImage";
import { formatCurrency, formatDate, formatTime, timeAgo } from "@/lib/format";
import type { LivePresentation, LiveSession, LiveSessionStats } from "@/lib/live-types";
import type { SaleRecord } from "@/lib/sales-analytics";
import type { Product } from "@/lib/types";

interface SessionItem {
  presentation: LivePresentation;
  sale: SaleRecord | null;
  product: Product | null;
}

interface SessionDetail {
  session: LiveSession;
  stats: LiveSessionStats;
  items: SessionItem[];
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="glass-panel rounded-2xl p-4 text-center">
      <p className="text-[10px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className={`mt-1 font-display text-xl font-extrabold ${accent ?? "text-ld-white"}`}>{value}</p>
    </div>
  );
}

// Same summary rendering as the real Session Summary — pointed at the
// isolated test endpoint and unmistakably labeled TEST SESSION. These
// numbers are never included in production Dashboard, real sales
// analytics, reorder calculations, or real Average Sale Price.
export default function TestLiveSessionSummaryPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<SessionDetail | null | "error">(null);

  useEffect(() => {
    fetch(`/api/live/test/session/${params.id}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(setDetail)
      .catch(() => setDetail("error"));
  }, [params.id]);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1100px] px-6 py-6">
        {detail === null ? (
          <p className="text-ld-muted">Loading…</p>
        ) : detail === "error" ? (
          <div className="glass-panel rounded-2xl p-10 text-center text-ld-red">This Test Session could not be found.</div>
        ) : (
          <>
            <div className="mb-1 inline-flex items-center gap-2 rounded-full bg-ld-amber/15 px-3 py-1 text-xs font-extrabold uppercase tracking-widest text-ld-amber">
              🧪 Test Session
            </div>
            <h1 className="mb-1 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">{detail.session.name}</h1>
            <p className="mb-6 text-sm text-ld-muted">
              {formatDate(detail.session.startedAt)} · {formatTime(detail.session.startedAt)}
              {detail.session.endedAt && ` – ${formatTime(detail.session.endedAt)}`}
              {detail.session.status === "active" && " · still running"}
            </p>

            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              <StatCard label="Duration" value={formatDuration(detail.stats.liveTimeMs)} />
              <StatCard label="Presented" value={String(detail.stats.productsPresented)} />
              <StatCard label="Units Sold" value={String(detail.stats.unitsSold)} />
              <StatCard label="No Sales" value={String(detail.stats.noSaleCount)} />
              <StatCard label="Simulated Revenue" value={formatCurrency(detail.stats.revenue)} accent="text-ld-amber" />
              <StatCard
                label="Simulated Gross Profit"
                value={detail.stats.estimatedGrossProfit != null ? formatCurrency(detail.stats.estimatedGrossProfit) : "—"}
              />
              <StatCard
                label="Sell-Through"
                value={detail.stats.presentationSellThrough != null ? `${Math.round(detail.stats.presentationSellThrough * 100)}%` : "—"}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard label="Avg Auction" value={detail.stats.averageAuction != null ? formatCurrency(detail.stats.averageAuction) : "—"} />
              <StatCard
                label="Avg Selling Price / Unit"
                value={detail.stats.averageSellingPricePerUnit != null ? formatCurrency(detail.stats.averageSellingPricePerUnit) : "—"}
              />
              <StatCard label="Highest Auction" value={detail.stats.highestAuction != null ? formatCurrency(detail.stats.highestAuction) : "—"} />
            </div>

            <h2 className="mb-3 mt-8 font-display text-lg font-bold text-ld-white">Products Presented</h2>
            {detail.items.length === 0 ? (
              <p className="rounded-xl border border-dashed border-ld-border p-6 text-center text-sm text-ld-muted">
                Nothing was presented in this rehearsal.
              </p>
            ) : (
              <div className="space-y-2">
                {detail.items.map((item) => {
                  const label = item.product ? `${item.product.brand} ${item.product.name}` : item.presentation.sku;
                  const canceled = item.sale?.status === "canceled";
                  return (
                    <div
                      key={item.presentation.id}
                      className={`glass-panel flex items-center gap-3 rounded-xl p-3 ${canceled ? "opacity-60" : ""}`}
                    >
                      {item.product ? (
                        <BottleImage src={item.product.image} alt={label} color={item.product.color} glow={false} className="h-10 w-10 shrink-0" />
                      ) : (
                        <div className="h-10 w-10 shrink-0 rounded-lg bg-ld-border/30" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ld-white">{label}</p>
                        <p className="text-xs text-ld-muted">
                          {timeAgo(item.presentation.timestamp)}
                          {item.presentation.quantity > 1 && ` · Qty ${item.presentation.quantity}`}
                          {item.sale?.originalPrice != null && ` · corrected from ${formatCurrency(item.sale.originalPrice)}`}
                          {canceled && " · cancelled"}
                        </p>
                      </div>
                      {item.presentation.outcome === "sold" ? (
                        <p className={`shrink-0 text-sm font-bold ${canceled ? "text-ld-red line-through" : "text-ld-amber"}`}>
                          {formatCurrency(item.sale?.price ?? 0)}
                        </p>
                      ) : (
                        <span className="shrink-0 rounded-full bg-ld-border/40 px-2 py-0.5 text-[10px] font-bold uppercase text-ld-muted">
                          No Sale
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
