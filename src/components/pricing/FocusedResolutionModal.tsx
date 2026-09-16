"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { MatchReviewResolutionPanel } from "@/components/pricing/MatchReviewResolutionPanel";
import { TrackForPricingModal } from "@/components/pricing/TrackForPricingModal";
import type { MatchReviewItem, PricingReferenceProduct } from "@/lib/pricing-types";
import type { Product } from "@/lib/types";

// ---------------------------------------------------------------------
// The focused single-item resolution view — what any workflow surfaces
// when it needs an exact Master Product/real-Product identity right now
// and the item is still genuinely ambiguous. Today's only caller is the
// operator's own explicit "Resolve Now"; a future Add-to-Order/
// Receiving workflow calls the exact same requestIdentityResolution
// helper (pricing-product-linking.ts) and would render this same modal.
// ---------------------------------------------------------------------

export function FocusedResolutionModal({ item: initialItem, onClose, onResolved }: { item: MatchReviewItem; onClose: () => void; onResolved: () => void }) {
  const [item, setItem] = useState(initialItem);
  const [products, setProducts] = useState<Product[]>([]);
  const [referenceProducts, setReferenceProducts] = useState<PricingReferenceProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const [trackModalOpen, setTrackModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvedMessage, setResolvedMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/products")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setProducts(Array.isArray(data) ? data : []))
      .catch(() => {});
    fetch("/api/pricing/reference-products?limit=500")
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data) => setReferenceProducts(Array.isArray(data.items) ? data.items : []))
      .catch(() => {});
  }, []);

  const resolve = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pricing/match-review/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: item.supplierId, offerKey: item.offerKey, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not resolve this item.");
      setResolvedMessage("Resolved.");
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const linkTracked = async (referenceProductId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pricing/suppliers/${item.supplierId}/offers/${encodeURIComponent(item.offerKey)}/link-reference-product`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceProductId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not link this item.");
      setItem((prev) => ({ ...prev, referenceProductId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="glass-panel w-full max-w-xl rounded-2xl p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-ld-white">Resolve This Item</h2>
          <button onClick={onClose} className="text-ld-muted hover:text-ld-white" aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="mb-4 rounded-xl border border-ld-red/30 bg-ld-red/5 p-3 text-sm text-ld-red">{error}</div>}

        {resolvedMessage ? (
          <div className="rounded-xl border border-ld-green/30 bg-ld-green/5 p-4 text-sm text-ld-green">
            {resolvedMessage}
            <div className="mt-3">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <MatchReviewResolutionPanel
            item={item}
            products={products}
            referenceProducts={referenceProducts}
            busy={busy}
            onResolve={resolve}
            onLinkTracked={linkTracked}
            onTrackForPricing={() => setTrackModalOpen(true)}
          />
        )}
      </div>

      {trackModalOpen && (
        <TrackForPricingModal
          item={item}
          onClose={() => setTrackModalOpen(false)}
          onSaved={() => {
            setTrackModalOpen(false);
            setResolvedMessage("Tracked for pricing.");
            onResolved();
          }}
        />
      )}
    </div>
  );
}
