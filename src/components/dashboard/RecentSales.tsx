"use client";

import type { Sale } from "@/lib/types";
import { BottleImage } from "@/components/BottleImage";
import { formatCurrency, timeAgo } from "@/lib/format";

export function RecentSales({ sales }: { sales: Sale[] }) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-sm font-bold uppercase tracking-widest text-ld-muted">
          Recent Sales
        </h3>
        {sales.length > 0 && (
          <span className="rounded-full bg-ld-green/15 px-2.5 py-0.5 text-xs font-bold text-ld-green">
            {sales.length} sold
          </span>
        )}
      </div>

      {sales.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ld-border p-4 text-center text-sm text-ld-muted">
          No sales yet this show.
        </p>
      ) : (
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {sales.map((sale) => (
            <div
              key={sale.id}
              className="flex items-center gap-3 rounded-xl border border-ld-border bg-black/20 p-2.5"
            >
              <BottleImage src={sale.image} alt={sale.name} color={sale.color} glow={false} className="h-10 w-10 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-white">{sale.name}</p>
                <p className="truncate text-xs text-ld-muted">
                  {sale.brand} · {sale.sku}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-bold text-ld-green">{formatCurrency(sale.price)}</p>
                <p className="text-[11px] text-ld-muted">{timeAgo(sale.soldAt)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
