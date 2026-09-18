"use client";

import { useEffect, useState, use } from "react";
import { Nav } from "@/components/Nav";
import { OfferComparisonTable } from "@/components/pricing/OfferComparisonTable";
import { formatCurrency, formatProductTitle } from "@/lib/format";
import type { Product } from "@/lib/types";
import type { ProductOfferComparison } from "@/lib/pricing-types";

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
          {product ? formatProductTitle(product.brand, product.name) : "Loading…"}
        </h1>
        {product && <p className="mb-6 text-sm text-ld-muted">{product.size} · SKU {product.sku}</p>}

        {comparison?.bestPrice ? (
          <div className="glass-panel mb-6 rounded-2xl border border-ld-green/30 p-5">
            <p className="text-[11px] font-bold uppercase tracking-widest text-ld-green">Current Best Price</p>
            <p className="font-display text-4xl font-extrabold text-ld-white">
              {formatCurrency(comparison.bestPrice.priceUsd)}
              <span className="ml-2 text-lg font-medium text-ld-muted">— {comparison.bestPrice.supplierName}</span>
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
            <OfferComparisonTable rows={comparison.actionable} bestOfferKey={comparison.bestPrice?.offerKey} />
          )}
        </div>

        {comparison && comparison.nonActionable.length > 0 && (
          <div className="glass-panel rounded-2xl p-5 opacity-70">
            <h2 className="mb-4 font-display text-lg font-bold text-ld-muted">Not Currently Actionable</h2>
            <OfferComparisonTable rows={comparison.nonActionable} />
          </div>
        )}
      </main>
    </div>
  );
}
