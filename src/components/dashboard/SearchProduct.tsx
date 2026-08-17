"use client";

import { useMemo, useState } from "react";
import type { Product } from "@/lib/types";
import { BottleImage } from "@/components/BottleImage";
import { formatCurrency } from "@/lib/format";
import { useLiveState } from "@/context/LiveStateContext";

export function SearchProduct({ products }: { products: Product[] }) {
  const { selectProduct, addToQueue } = useLiveState();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.brand.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.barcode.toLowerCase().includes(q)
      )
      .slice(0, 6);
  }, [products, query]);

  return (
    <div className="glass-panel rounded-2xl p-5">
      <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-widest text-ld-muted">
        Search Product
      </h3>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, brand, or SKU…"
        className="w-full rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-3 text-sm text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple focus:ring-4 focus:ring-ld-purple/15"
      />

      {results.length > 0 && (
        <div className="mt-3 space-y-2">
          {results.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-xl border border-ld-border bg-ld-bg-elevated p-2.5"
            >
              <BottleImage src={p.image} alt={p.name} color={p.color} glow={false} className="h-10 w-10 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ld-white">{p.name}</p>
                <p className="truncate text-xs text-ld-muted">
                  {p.brand} · {formatCurrency(p.lootPrice)} · {p.sku}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  disabled={busyId !== null}
                  onClick={async () => {
                    setBusyId(p.id);
                    await selectProduct(p.id);
                    setBusyId(null);
                    setQuery("");
                  }}
                  className="rounded-lg bg-ld-purple px-2.5 py-1.5 text-xs font-bold text-ld-white hover:brightness-105"
                >
                  Go Live
                </button>
                <button
                  disabled={busyId !== null}
                  onClick={async () => {
                    setBusyId(p.id);
                    await addToQueue(p.id);
                    setBusyId(null);
                    setQuery("");
                  }}
                  className="rounded-lg bg-ld-border/40 px-2.5 py-1.5 text-xs font-bold text-ld-muted hover:bg-ld-border/70 hover:text-ld-white"
                >
                  + Queue
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {query && results.length === 0 && (
        <p className="mt-3 text-sm text-ld-muted">No products match &ldquo;{query}&rdquo;.</p>
      )}
    </div>
  );
}
