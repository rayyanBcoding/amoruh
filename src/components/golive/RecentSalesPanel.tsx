"use client";

import { useState } from "react";
import { BottleImage } from "@/components/BottleImage";
import { formatCurrency, timeAgo } from "@/lib/format";
import { useLiveSession, type RecentSaleView } from "@/context/LiveSessionContext";

function RecentRow({ view }: { view: RecentSaleView }) {
  const { cancelSale, correctSale } = useLiveSession();
  const [busy, setBusy] = useState<"cancel" | "correct" | null>(null);
  const [editing, setEditing] = useState(false);
  const [newPrice, setNewPrice] = useState("");

  const { presentation, sale, product } = view;
  const label = product ? `${product.brand} ${product.name}` : presentation.sku;

  if (presentation.outcome === "no_sale") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-ld-border bg-ld-bg-elevated p-2.5 opacity-70">
        {product ? (
          <BottleImage src={product.image} alt={label} color={product.color} glow={false} className="h-10 w-10 shrink-0" />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-lg bg-ld-border/30" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ld-white">{label}</p>
          <p className="text-xs text-ld-muted">No Sale · {timeAgo(presentation.timestamp)}</p>
        </div>
        <span className="shrink-0 rounded-full bg-ld-border/40 px-2 py-0.5 text-[10px] font-bold uppercase text-ld-muted">No Sale</span>
      </div>
    );
  }

  const canceled = sale?.status === "canceled";

  return (
    <div className={`rounded-xl border p-2.5 ${canceled ? "border-ld-red/30 bg-ld-red/5 opacity-70" : "border-ld-border bg-ld-bg-elevated"}`}>
      <div className="flex items-center gap-3">
        {product ? (
          <BottleImage src={product.image} alt={label} color={product.color} glow={false} className="h-10 w-10 shrink-0" />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-lg bg-ld-border/30" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ld-white">{label}</p>
          <p className="truncate text-xs text-ld-muted">
            {presentation.quantity > 1 ? `Qty ${presentation.quantity} · ` : ""}
            {timeAgo(presentation.timestamp)}
            {sale?.originalPrice != null && !canceled && <span className="text-ld-amber"> · corrected</span>}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className={`text-sm font-bold ${canceled ? "text-ld-red line-through" : "text-ld-green"}`}>
            {formatCurrency(sale?.price ?? 0)}
          </p>
        </div>
      </div>

      {!canceled && sale && (
        <div className="mt-2 flex items-center gap-2">
          {editing ? (
            <>
              <input
                autoFocus
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                placeholder={String(sale.price)}
                className="w-24 rounded-lg border border-ld-border bg-ld-bg px-2 py-1 text-xs text-ld-white outline-none focus:border-ld-purple"
              />
              <button
                disabled={busy !== null}
                onClick={async () => {
                  const value = Number(newPrice);
                  if (!Number.isFinite(value) || value < 0) return;
                  setBusy("correct");
                  await correctSale(sale.id, value);
                  setBusy(null);
                  setEditing(false);
                  setNewPrice("");
                }}
                className="rounded-lg bg-ld-cyan/20 px-2 py-1 text-[11px] font-bold text-ld-cyan hover:bg-ld-cyan/30"
              >
                Save
              </button>
              <button onClick={() => setEditing(false)} className="text-[11px] font-semibold text-ld-muted hover:text-ld-white">
                Cancel
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)} className="text-[11px] font-semibold text-ld-cyan hover:underline">
                Correct Price
              </button>
              <button
                disabled={busy !== null}
                onClick={async () => {
                  if (!window.confirm("Cancel this sale? Inventory will be restored.")) return;
                  setBusy("cancel");
                  await cancelSale(sale.id);
                  setBusy(null);
                }}
                className="text-[11px] font-semibold text-ld-red hover:underline"
              >
                {busy === "cancel" ? "Cancelling…" : "Cancel Sale"}
              </button>
            </>
          )}
        </div>
      )}
      {canceled && <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-ld-red">Cancelled</p>}
    </div>
  );
}

export function RecentSalesPanel({ recent }: { recent: RecentSaleView[] }) {
  const soldCount = recent.filter((r) => r.presentation.outcome === "sold" && r.sale?.status !== "canceled").length;

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Recent Sales</h3>
        {soldCount > 0 && (
          <span className="rounded-full bg-ld-green/15 px-2.5 py-0.5 text-xs font-bold text-ld-green">{soldCount} sold</span>
        )}
      </div>
      {recent.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ld-border p-4 text-center text-sm text-ld-muted">
          Nothing recorded yet this Live.
        </p>
      ) : (
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {recent.map((v) => (
            <RecentRow key={v.presentation.id} view={v} />
          ))}
        </div>
      )}
    </div>
  );
}
