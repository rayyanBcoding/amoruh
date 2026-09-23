"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";

interface SupplierSummary {
  supplierId: string;
  supplierName: string;
  competitiveProductCount: number;
  outrightWins: number;
  ties: number;
  winRate: number;
  avgPerUnitSavingsUsd: number;
  totalPerUnitSavingsUsd: number;
  singleSupplierOnlyCount: number;
  currentEligibleOfferCount: number;
}

interface LeaderboardSummary {
  suppliers: SupplierSummary[];
  totals: { competitiveProductCount: number; outrightWinProductCount: number; tiedProductCount: number };
  computedAt: string;
}

/** Supplier Price Leaders — the main purchasing-intelligence section.
 *  Reads /api/pricing/leaderboard, which does one freshness-verified
 *  cache read (recomputing synchronously if stale) rather than a live
 *  per-product comparison call. Clicking a supplier opens its dedicated
 *  drill-down (the existing supplier detail page's new "Price Wins"
 *  section) — never a duplicate product-detail page. */
export function SupplierPriceLeaders() {
  const router = useRouter();
  const [data, setData] = useState<LeaderboardSummary | null>(null);

  useEffect(() => {
    fetch("/api/pricing/leaderboard")
      .then((res) => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => {});
  }, []);

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-ld-white">Supplier Price Leaders</h2>
        {data && (
          <p className="text-xs text-ld-muted">
            {data.totals.competitiveProductCount.toLocaleString()} products with 2+ suppliers ·{" "}
            {data.totals.outrightWinProductCount.toLocaleString()} outright wins · {data.totals.tiedProductCount.toLocaleString()} tied
          </p>
        )}
      </div>

      {!data ? (
        <p className="text-sm text-ld-muted">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {[...data.suppliers]
            .sort((a, b) => b.outrightWins - a.outrightWins)
            .map((s) => (
              <button
                key={s.supplierId}
                onClick={() => router.push(`/pricing/suppliers/${s.supplierId}`)}
                className="rounded-xl bg-ld-bg-elevated p-4 text-left transition-colors hover:bg-ld-border/30"
              >
                <p className="mb-1 font-semibold text-ld-white">{s.supplierName}</p>
                <p className="font-display text-2xl font-extrabold text-ld-green">{s.outrightWins.toLocaleString()}</p>
                <p className="mb-2 text-[11px] uppercase tracking-wide text-ld-muted">
                  outright win{s.outrightWins === 1 ? "" : "s"}
                  {s.ties > 0 && <span className="text-ld-amber"> · {s.ties} tied</span>}
                </p>
                <dl className="space-y-1 text-xs text-ld-muted">
                  <div className="flex justify-between">
                    <dt>Win rate</dt>
                    <dd className="font-semibold text-ld-white">
                      {s.winRate}% <span className="text-ld-muted">of {s.competitiveProductCount.toLocaleString()}</span>
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt title="Sum of per-unit price advantages across won products — a comparison signal, not projected order savings">
                      Per-unit savings
                    </dt>
                    <dd className="font-semibold text-ld-white">{formatCurrency(s.totalPerUnitSavingsUsd)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Sole supplier for</dt>
                    <dd className="text-ld-white">{s.singleSupplierOnlyCount.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Eligible offers</dt>
                    <dd className="text-ld-white">{s.currentEligibleOfferCount.toLocaleString()}</dd>
                  </div>
                </dl>
              </button>
            ))}
        </div>
      )}
      <p className="mt-3 text-[11px] text-ld-muted">
        &ldquo;Per-unit savings&rdquo; is the sum of per-unit price advantages on won products — not a projected or realized order total. Ties and
        single-supplier products are tracked separately and are never counted as an outright win.
      </p>
    </div>
  );
}
