"use client";

import { useEffect, useState, use } from "react";
import { Nav } from "@/components/Nav";
import { OfferComparisonTable } from "@/components/pricing/OfferComparisonTable";
import { formatCurrency, formatProductTitle } from "@/lib/format";
import type { PricingReferenceProduct, ReferenceProductOfferComparison } from "@/lib/pricing-types";

// Direct twin of /pricing/products/[id] for a Master Product AMORUH has
// never (yet) physically stocked — same comparison logic, same
// component, keyed by referenceProductId instead of productId. Only
// ever reached for a Master Product that ISN'T linked to a real Product
// (search already excludes linked ones from reference_product results —
// see /api/pricing/search — since a linked pair is one identity, shown
// only via its real-Product page).
export default function ReferenceProductComparisonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [product, setProduct] = useState<PricingReferenceProduct | null>(null);
  const [comparison, setComparison] = useState<ReferenceProductOfferComparison | null>(null);

  useEffect(() => {
    fetch(`/api/pricing/reference-products/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setProduct)
      .catch(() => {});
    fetch(`/api/pricing/reference-products/${id}/offers`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setComparison)
      .catch(() => {});
  }, [id]);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1000px] px-6 py-6">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
            {product ? formatProductTitle(product.brand, product.name) : "Loading…"}
          </h1>
          <span className="rounded-full bg-ld-purple/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-ld-purple">
            Master Product — Not Carried
          </span>
        </div>
        {product && (
          <p className="mb-6 text-sm text-ld-muted">
            {product.sizeMl ? `${product.sizeMl}ml` : "Size unknown"}
            {product.concentration ? ` · ${product.concentration}` : ""}
          </p>
        )}

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

        {comparison && comparison.unresolvedElsewhereCount > 0 && (
          <div className="glass-panel mb-6 rounded-2xl border border-ld-amber/30 bg-ld-amber/5 p-4">
            <p className="text-sm text-ld-amber">
              <span className="font-bold">
                {comparison.unresolvedElsewhereCount} unresolved supplier offer{comparison.unresolvedElsewhereCount === 1 ? "" : "s"}
              </span>{" "}
              elsewhere may be additional options for this exact product — not shown here because their identity hasn&apos;t been
              confirmed yet. Check Match Review / search before assuming this list is complete.
            </p>
          </div>
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
