"use client";

import { ListedBadge, StaleBadge } from "@/components/pricing/PricingBadges";
import { formatCurrency } from "@/lib/format";
import type { OfferComparisonRow } from "@/lib/pricing-types";

// ---------------------------------------------------------------------
// The supplier-comparison table for one Master Product — shared between
// the real-Product comparison page and the reference-only Master
// Product comparison page, so a linked-or-not identity always looks and
// behaves identically. Rows are already sorted (lowest USD price first)
// and pre-computed (differenceFromBestUsd) by the comparison functions
// in pricing-db.ts — this component only renders, never re-derives.
// ---------------------------------------------------------------------

export function OfferComparisonTable({ rows, bestOfferKey }: { rows: OfferComparisonRow[]; bestOfferKey?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-separate border-spacing-y-2 text-sm">
        <thead>
          <tr className="text-left text-[11px] font-bold uppercase tracking-widest text-ld-muted">
            <th className="px-3 pb-1">Supplier</th>
            <th className="px-3 pb-1">Price</th>
            <th className="px-3 pb-1">USD</th>
            <th className="px-3 pb-1">vs Best</th>
            <th className="px-3 pb-1">Stock</th>
            <th className="px-3 pb-1">Status</th>
            <th className="px-3 pb-1">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isBest = r.offerKey === bestOfferKey;
            return (
              <tr
                key={`${r.supplierId}:${r.offerKey}`}
                className={`rounded-xl px-3 py-2 ${isBest ? "bg-ld-green/10 ring-1 ring-inset ring-ld-green/30" : "bg-ld-bg-elevated"}`}
              >
                <td className="rounded-l-xl px-3 py-2.5 font-medium text-ld-white">
                  {r.supplierName}
                  {isBest && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-ld-green/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-ld-green">
                      Best Price
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-ld-white">
                  {formatCurrency(r.price)} {r.currency !== "USD" && <span className="text-ld-muted">{r.currency}</span>}
                </td>
                <td className="px-3 py-2.5 text-ld-amber">{formatCurrency(r.priceUsd)}</td>
                <td className="px-3 py-2.5">
                  {r.differenceFromBestUsd === null || isBest ? (
                    <span className="text-ld-muted">—</span>
                  ) : r.differenceFromBestUsd >= 0 ? (
                    <span className="text-ld-muted">+{formatCurrency(r.differenceFromBestUsd)}</span>
                  ) : (
                    // A nonActionable row (stale/out-of-stock/unreviewed)
                    // that was actually cheaper than today's valid best —
                    // shown for context, never implying it's usable now.
                    <span className="text-ld-cyan" title="Cheaper, but not currently actionable">
                      −{formatCurrency(Math.abs(r.differenceFromBestUsd))}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-ld-muted">{r.quantity ?? "—"}</td>
                <td className="px-3 py-2.5">
                  <ListedBadge currentlyListed={r.currentlyListed} quantity={r.quantity} />
                  <StaleBadge isStale={r.isStale} ageDays={r.ageDays} />
                </td>
                <td className="rounded-r-xl px-3 py-2.5 text-xs text-ld-muted">{new Date(r.uploadedAt).toLocaleDateString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
