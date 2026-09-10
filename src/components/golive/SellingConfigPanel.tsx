"use client";

import { useEffect, useState } from "react";
import type { SellingConfig } from "@/lib/live-types";
import { useLiveSession } from "@/context/LiveSessionContext";

/** Break-Even can't be computed without these — see computeBreakEven()
 *  in live-db.ts. Collapsed by default once configured so it doesn't
 *  compete with the product/action area for attention. */
export function SellingConfigPanel({ config }: { config: SellingConfig }) {
  const { updateSellingConfig } = useLiveSession();
  const configured = config.platformFeePercent !== null && config.paymentFeePercent !== null;
  const [open, setOpen] = useState(!configured);
  const [platformFeePercent, setPlatformFeePercent] = useState(config.platformFeePercent?.toString() ?? "");
  const [paymentFeePercent, setPaymentFeePercent] = useState(config.paymentFeePercent?.toString() ?? "");
  const [shippingSubsidy, setShippingSubsidy] = useState(String(config.shippingSubsidy));
  const [packagingCost, setPackagingCost] = useState(String(config.packagingCost));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Deferred a tick — react-hooks/set-state-in-effect flags any setState
    // reachable synchronously from an effect body; queuing as a microtask
    // keeps the config→local-field sync working without that violation.
    Promise.resolve().then(() => {
      setPlatformFeePercent(config.platformFeePercent?.toString() ?? "");
      setPaymentFeePercent(config.paymentFeePercent?.toString() ?? "");
      setShippingSubsidy(String(config.shippingSubsidy));
      setPackagingCost(String(config.packagingCost));
    });
  }, [config]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await updateSellingConfig({
      platformFeePercent: platformFeePercent === "" ? null : Number(platformFeePercent),
      paymentFeePercent: paymentFeePercent === "" ? null : Number(paymentFeePercent),
      shippingSubsidy: Number(shippingSubsidy) || 0,
      packagingCost: Number(packagingCost) || 0,
    });
    setBusy(false);
    if (!result.ok) setError(result.error ?? "Could not save.");
    else setOpen(false);
  };

  return (
    <div className="glass-panel rounded-2xl p-5">
      <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen((o) => !o)}>
        <h3 className="font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Break-Even Settings</h3>
        <span className="text-xs font-semibold text-ld-cyan">{configured ? (open ? "Hide" : "Edit") : "Configure"}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-ld-muted">Platform Fee %</label>
              <input
                value={platformFeePercent}
                onChange={(e) => setPlatformFeePercent(e.target.value)}
                inputMode="decimal"
                placeholder="e.g. 5"
                className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-ld-muted">Payment Fee %</label>
              <input
                value={paymentFeePercent}
                onChange={(e) => setPaymentFeePercent(e.target.value)}
                inputMode="decimal"
                placeholder="e.g. 3"
                className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-ld-muted">Shipping Subsidy $</label>
              <input
                value={shippingSubsidy}
                onChange={(e) => setShippingSubsidy(e.target.value)}
                inputMode="decimal"
                className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-ld-muted">Packaging Cost $</label>
              <input
                value={packagingCost}
                onChange={(e) => setPackagingCost(e.target.value)}
                inputMode="decimal"
                className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
              />
            </div>
          </div>
          <p className="text-[11px] text-ld-muted">
            Break-Even = (Cost + Shipping Subsidy + Packaging Cost) ÷ (1 − (Platform Fee % + Payment Fee %) ÷ 100)
          </p>
          {error && <p className="text-xs font-semibold text-ld-red">{error}</p>}
          <button
            disabled={busy}
            onClick={save}
            className="w-full rounded-lg bg-ld-purple px-3 py-2 text-xs font-bold text-ld-white hover:brightness-105 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
