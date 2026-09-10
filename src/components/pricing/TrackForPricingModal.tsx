"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import type { MatchReviewItem } from "@/lib/pricing-types";

/** "Track for Pricing" — creates (or, if a matching UPC/EAN already
 *  exists, links to) a PricingReferenceProduct. Deliberately NOT the
 *  full CreateProductModal (real-catalog fields like SKU/cost/status
 *  don't apply here) — just enough to name what you're tracking. */
export function TrackForPricingModal({
  item,
  onClose,
  onSaved,
}: {
  item: MatchReviewItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [brand, setBrand] = useState(item.brand || "");
  const [name, setName] = useState(item.description || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkedExisting, setLinkedExisting] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/pricing/suppliers/${item.supplierId}/offers/${encodeURIComponent(item.offerKey)}/create-reference-product`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brand: brand.trim(), name: name.trim() }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.error ?? "Could not track this item.");
      if (data.linkedExisting) {
        setLinkedExisting(true);
        window.setTimeout(onSaved, 900);
      } else {
        onSaved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="glass-panel w-full max-w-md rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <p className="text-xs font-bold uppercase tracking-widest text-ld-cyan">📎 Track for Pricing</p>
        <p className="mt-1 text-sm text-ld-muted">
          Names this item within Pricing/Ordering only — it will never appear in Inventory, Go Live, or Dashboard.
        </p>

        {linkedExisting ? (
          <p className="mt-5 rounded-xl border border-ld-cyan/40 bg-ld-cyan/10 p-4 text-sm text-ld-cyan">
            A tracked item with this UPC/EAN already exists — linked to it instead of creating a duplicate.
          </p>
        ) : (
          <div className="mt-5 space-y-3">
            <div>
              <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">Brand</label>
              <input
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                className="w-full rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-2.5 text-sm text-ld-white outline-none focus:border-ld-purple"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-2.5 text-sm text-ld-white outline-none focus:border-ld-purple"
              />
            </div>
            {item.upc && <p className="text-xs text-ld-muted">UPC {item.upc} will be saved for exact-match cross-supplier linking.</p>}

            {error && <p className="text-sm font-semibold text-ld-red">{error}</p>}

            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="lg" className="flex-1" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="cyan" size="lg" className="flex-1" onClick={save} disabled={busy || !brand.trim() || !name.trim()}>
                {busy ? "Saving…" : "Track"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
