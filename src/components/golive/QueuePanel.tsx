"use client";

import { useState } from "react";
import type { Product } from "@/lib/types";
import { BottleImage } from "@/components/BottleImage";
import { useLiveSession } from "@/context/LiveSessionContext";

function QueueRow({ product, rank }: { product: Product; rank: number }) {
  const { selectProduct, removeFromQueue } = useLiveSession();
  const [busy, setBusy] = useState<"go" | "remove" | null>(null);

  return (
    <div className="group flex items-center gap-3 rounded-xl border border-ld-border bg-ld-bg-elevated p-3 transition-colors hover:border-ld-purple/50">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ld-border/40 text-xs font-bold text-ld-muted">
        {rank}
      </span>
      <BottleImage src={product.image} alt={product.name} color={product.color} glow={false} className="h-12 w-12 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ld-white">{product.name}</p>
        <p className="truncate text-xs text-ld-muted">
          {product.brand} · {product.inventory} in stock
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
          Load Now
        </button>
        <button
          disabled={busy !== null}
          onClick={async () => {
            setBusy("remove");
            await removeFromQueue(product.id);
            setBusy(null);
          }}
          className="rounded-lg bg-ld-red/15 px-2.5 py-1.5 text-xs font-bold text-ld-red hover:bg-ld-red/25"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export function QueuePanel({ queue }: { queue: Product[] }) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Up Next</h3>
        {queue.length > 0 && (
          <span className="rounded-full bg-ld-purple/15 px-2.5 py-0.5 text-xs font-bold text-ld-purple">{queue.length} queued</span>
        )}
      </div>
      {queue.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ld-border p-4 text-center text-sm text-ld-muted">
          Nothing queued — search below to add products.
        </p>
      ) : (
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {queue.map((p, i) => (
            <QueueRow key={p.id} product={p} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
