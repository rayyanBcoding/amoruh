"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import type { Product } from "@/lib/types";

interface RecordSaleModalProps {
  product: Product;
  onConfirm: (input: { quantity: number; winningBid: number }) => Promise<void>;
  onClose: () => void;
}

/** WINNING BID $______ — the entire point is that this is FAST: one
 *  number field, focused on mount, Enter submits. Quantity defaults to 1
 *  and stays out of the way unless the operator actually needs it. */
export function RecordSaleModal({ product, onConfirm, onClose }: RecordSaleModalProps) {
  const [bid, setBid] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [showQuantity, setShowQuantity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    const amount = Number(bid);
    if (!Number.isFinite(amount) || amount < 0) {
      setError("Enter a valid winning bid.");
      return;
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setError("Quantity must be a positive whole number.");
      return;
    }
    setBusy(true);
    setError(null);
    await onConfirm({ quantity, winningBid: amount });
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="glass-panel w-full max-w-md rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs font-bold uppercase tracking-widest text-ld-muted">Record Sale</p>
        <p className="mt-1 text-lg font-semibold text-ld-white">
          {product.brand} {product.name}
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="mt-5 space-y-4"
        >
          <div>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">
              Winning Bid {quantity > 1 && "(total for all units)"}
            </label>
            <div className="flex items-center gap-2 rounded-xl border-2 border-ld-border bg-ld-bg-elevated px-4 py-3 focus-within:border-ld-purple focus-within:ring-4 focus-within:ring-ld-purple/15">
              <span className="text-2xl font-bold text-ld-muted">$</span>
              <input
                ref={inputRef}
                value={bid}
                onChange={(e) => setBid(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                className="w-full bg-transparent font-display text-3xl font-extrabold text-ld-white outline-none"
              />
            </div>
          </div>

          {showQuantity ? (
            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">Quantity</label>
              <input
                type="number"
                min={1}
                step={1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                className="w-24 rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-center text-sm font-semibold text-ld-white outline-none focus:border-ld-purple"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowQuantity(true)}
              className="text-xs font-semibold text-ld-cyan hover:underline"
            >
              Sold more than 1? Set quantity
            </button>
          )}

          {error && <p className="text-sm font-medium text-ld-red">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="ghost" size="lg" className="flex-1" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="cyan" size="lg" className="flex-1" disabled={busy || !bid}>
              {busy ? "Recording…" : "Confirm Sale"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
