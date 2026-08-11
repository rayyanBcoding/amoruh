"use client";

import { useState } from "react";
import type { Product } from "@/lib/types";
import { BottleImage } from "@/components/BottleImage";
import { formatCurrency } from "@/lib/format";
import { useLiveState } from "@/context/LiveStateContext";

function QueueRow({ product, rank }: { product: Product; rank: number }) {
  const { selectProduct, removeFromQueue } = useLiveState();
  const [busy, setBusy] = useState<"go" | "remove" | null>(null);

  return (
    <div className="group flex items-center gap-3 rounded-xl border border-ld-border bg-black/20 p-3 transition-colors hover:border-ld-purple/40">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/5 text-xs font-bold text-ld-muted">
        {rank}
      </span>
      <BottleImage src={product.image} alt={product.name} color={product.color} glow={false} className="h-12 w-12 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-white">{product.name}</p>
        <p className="truncate text-xs text-ld-muted">
          {product.brand} · {formatCurrency(product.lootPrice)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          disabled={busy !== null}
          onClick={async () => {
            setBusy("go");
            await selectProduct(product.id);
            setBusy(null);
          }}
          className="rounded-lg bg-ld-purple/20 px-2.5 py-1.5 text-xs font-bold text-ld-purple hover:bg-ld-purple/30"
        >
          Go Live
        </button>
        <button
          disabled={busy !== null}
          onClick={async () => {
            setBusy("remove");
            await removeFromQueue(product.id);
            setBusy(null);
          }}
          className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold text-ld-muted hover:bg-white/10 hover:text-white"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export function QueuePanel({ queue }: { queue: Product[] }) {
  const [onDeck, ...rest] = queue;

  return (
    <div className="glass-panel rounded-2xl p-5">
      <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-widest text-ld-muted">
        Coming Up Next
      </h3>

      {onDeck ? (
        <div className="mb-4 flex items-center gap-4 rounded-xl border border-ld-cyan/30 bg-ld-cyan/5 p-4">
          <BottleImage src={onDeck.image} alt={onDeck.name} color={onDeck.color} className="h-16 w-16 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-lg font-bold text-white">{onDeck.name}</p>
            <p className="text-sm text-ld-muted">
              {onDeck.brand} · {formatCurrency(onDeck.lootPrice)} · Shelf {onDeck.shelf}
            </p>
          </div>
        </div>
      ) : (
        <p className="mb-4 rounded-xl border border-dashed border-ld-border p-4 text-center text-sm text-ld-muted">
          Queue is empty — add products from search below.
        </p>
      )}

      {rest.length > 0 && (
        <>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-widest text-ld-muted">
            Live Queue ({rest.length})
          </h4>
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {rest.map((p, i) => (
              <QueueRow key={p.id} product={p} rank={i + 2} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
