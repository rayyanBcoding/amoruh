"use client";

import { useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { ReviewStatusBadge } from "@/components/pricing/PricingBadges";
import { CreateProductModal } from "@/components/intake/CreateProductModal";
import { formatCurrency } from "@/lib/format";
import type { MatchReviewItem } from "@/lib/pricing-types";
import type { Product } from "@/lib/types";

export default function MatchReviewPage() {
  const [items, setItems] = useState<MatchReviewItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [createModalFor, setCreateModalFor] = useState<MatchReviewItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const itemKey = (i: MatchReviewItem) => `${i.supplierId}::${i.offerKey}`;

  const load = () => {
    fetch("/api/pricing/match-review")
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data) => setItems(data.items ?? []))
      .catch(() => {});
    fetch("/api/products")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setProducts(Array.isArray(data) ? data : []))
      .catch(() => {});
  };

  useEffect(load, []);

  const resolve = async (item: MatchReviewItem, body: Record<string, unknown>) => {
    setBusyKey(itemKey(item));
    setError(null);
    try {
      const res = await fetch("/api/pricing/match-review/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: item.supplierId, offerKey: item.offerKey, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not resolve this item.");
      setItems((prev) => prev.filter((i) => itemKey(i) !== itemKey(item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyKey(null);
    }
  };

  const candidateLabel = (productId: string | null) => {
    if (!productId) return null;
    const p = products.find((pr) => pr.id === productId);
    return p ? `${p.brand} ${p.name} (${p.size})` : null;
  };

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1300px] px-6 py-6">
        <h1 className="mb-1 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">Match Review</h1>
        <p className="mb-6 text-sm text-ld-muted">{items.length} listing{items.length === 1 ? "" : "s"} need a decision.</p>

        {error && <div className="glass-panel mb-6 rounded-xl border border-ld-red/30 p-4 text-sm text-ld-red">{error}</div>}

        {items.length === 0 ? (
          <div className="glass-panel rounded-2xl p-10 text-center text-ld-muted">Nothing needs review right now.</div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => {
              const key = itemKey(item);
              const busy = busyKey === key;
              const label = candidateLabel(item.candidateProductId);
              return (
                <div key={key} className="glass-panel rounded-2xl p-5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold text-ld-white">{item.description || item.brand}</p>
                      <p className="text-xs text-ld-muted">
                        {item.supplierName} · {formatCurrency(item.price)} {item.currency !== "USD" && `(${item.currency})`}
                        {item.upc && ` · UPC ${item.upc}`}
                      </p>
                    </div>
                    <ReviewStatusBadge status={item.reviewStatus} confidence={item.matchConfidence} />
                  </div>

                  {label && (
                    <p className="mb-3 text-sm text-ld-white">
                      Is this the same product? <span className="font-semibold text-ld-cyan">{label}</span>
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {item.candidateProductId && (
                      <Button
                        variant="cyan"
                        size="md"
                        disabled={busy}
                        onClick={() => resolve(item, { action: "link", productId: item.candidateProductId })}
                      >
                        Yes — Link
                      </Button>
                    )}
                    <select
                      disabled={busy}
                      value=""
                      onChange={(e) => e.target.value && resolve(item, { action: "link", productId: e.target.value })}
                      className="rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-xs text-ld-white outline-none focus:border-ld-purple"
                    >
                      <option value="">Search Another Product…</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.brand} {p.name} ({p.size})
                        </option>
                      ))}
                    </select>
                    <Button variant="outline" size="md" disabled={busy} onClick={() => setCreateModalFor(item)}>
                      Create New Product
                    </Button>
                    <Button variant="ghost" size="md" disabled={busy} onClick={() => resolve(item, { action: "ignore" })}>
                      Ignore
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {createModalFor && (
        <CreateProductModal
          initialValues={{
            sku: createModalFor.upc || "",
            barcode: createModalFor.upc || "",
            brand: createModalFor.brand,
            name: createModalFor.description,
            description: createModalFor.description,
            cost: createModalFor.price,
            status: "draft",
          }}
          createUrl={`/api/pricing/suppliers/${createModalFor.supplierId}/offers/${encodeURIComponent(createModalFor.offerKey)}/create-product`}
          onCreated={() => {
            setItems((prev) => prev.filter((i) => itemKey(i) !== itemKey(createModalFor)));
            setCreateModalFor(null);
          }}
          onClose={() => setCreateModalFor(null)}
        />
      )}
    </div>
  );
}
