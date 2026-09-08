"use client";

import { useEffect, useState, use } from "react";
import { Nav } from "@/components/Nav";
import { ListedBadge, StaleBadge } from "@/components/pricing/PricingBadges";
import { formatCurrency } from "@/lib/format";
import type { Product } from "@/lib/types";
import type { ProductOfferComparison, OfferComparisonRow } from "@/lib/pricing-types";

export default function ProductComparisonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [product, setProduct] = useState<Product | null>(null);
  const [comparison, setComparison] = useState<ProductOfferComparison | null>(null);

  useEffect(() => {
    fetch(`/api/products/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setProduct)
      .catch(() => {});
    fetch(`/api/pricing/products/${id}/offers`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setComparison)
      .catch(() => {});
  }, [id]);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1000px] px-6 py-6">
        <h1 className="mb-1 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
          {product ? `${product.brand} ${product.name}` : "Loading…"}
        </h1>
        {product && <p className="mb-6 text-sm text-ld-muted">{product.size} · SKU {product.sku}</p>}

        {comparison?.bestPrice ? (
          <div className="glass-panel mb-6 rounded-2xl border border-ld-green/30 p-5">
            <p className="text-[11px] font-bold uppercase tracking-widest text-ld-green">Best Current Price</p>
            <p className="font-display text-4xl font-extrabold text-ld-white">
              {formatCurrency(comparison.bestPrice.priceUsd)}
              <span className="ml-2 text-lg font-medium text-ld-muted">from {comparison.bestPrice.supplierName}</span>
            </p>
          </div>
        ) : (
          comparison && (
            <div className="glass-panel mb-6 rounded-2xl p-5 text-sm text-ld-muted">
              No current actionable price — every offer is stale, out of stock, no longer listed, or still awaiting match review.
            </div>
          )
        )}

        <div className="glass-panel mb-6 rounded-2xl p-5">
          <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Actionable Offers</h2>
          {!comparison || comparison.actionable.length === 0 ? (
            <p className="text-sm text-ld-muted">None right now.</p>
          ) : (
            <OfferTable rows={comparison.actionable} highlightBest={comparison.bestPrice?.offerKey} />
          )}
        </div>

        {comparison && comparison.nonActionable.length > 0 && (
          <div className="glass-panel rounded-2xl p-5 opacity-70">
            <h2 className="mb-4 font-display text-lg font-bold text-ld-muted">Not Currently Actionable</h2>
            <OfferTable rows={comparison.nonActionable} />
          </div>
        )}
      </main>
    </div>
  );
}

function OfferTable({ rows, highlightBest }: { rows: OfferComparisonRow[]; highlightBest?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] border-separate border-spacing-y-2 text-sm">
        <thead>
          <tr className="text-left text-[11px] font-bold uppercase tracking-widest text-ld-muted">
            <th className="px-3 pb-1">Supplier</th>
            <th className="px-3 pb-1">Price</th>
            <th className="px-3 pb-1">USD</th>
            <th className="px-3 pb-1">Stock</th>
            <th className="px-3 pb-1">Status</th>
            <th className="px-3 pb-1">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.supplierId}:${r.offerKey}`}
              className={`rounded-xl px-3 py-2 ${r.offerKey === highlightBest ? "bg-ld-green/10 ring-1 ring-inset ring-ld-green/30" : "bg-ld-bg-elevated"}`}
            >
              <td className="rounded-l-xl px-3 py-2.5 font-medium text-ld-white">{r.supplierName}</td>
              <td className="px-3 py-2.5 text-ld-white">
                {formatCurrency(r.price)} {r.currency !== "USD" && <span className="text-ld-muted">{r.currency}</span>}
              </td>
              <td className="px-3 py-2.5 text-ld-amber">{formatCurrency(r.priceUsd)}</td>
              <td className="px-3 py-2.5 text-ld-muted">{r.quantity ?? "—"}</td>
              <td className="px-3 py-2.5">
                <ListedBadge currentlyListed={r.currentlyListed} quantity={r.quantity} />
                <StaleBadge isStale={r.isStale} ageDays={r.ageDays} />
              </td>
              <td className="rounded-r-xl px-3 py-2.5 text-xs text-ld-muted">{new Date(r.uploadedAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
