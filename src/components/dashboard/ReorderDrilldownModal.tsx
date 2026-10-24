"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DrilldownSession, ForwardLooking, ReorderRow } from "@/lib/reorder-intelligence";
import type { SupplierCostInfo } from "@/lib/reorder-db";
import type { WindowKey } from "@/lib/reorder-config";
import { TARGET_GROSS_MARGIN, WINDOWS } from "@/lib/reorder-config";
import { formatCurrency, formatDate } from "@/lib/format";

interface DrilldownResponse {
  sessions: DrilldownSession[];
  row: ReorderRow | null;
  supplier: SupplierCostInfo | null;
  forward: ForwardLooking | null;
}

const money = (n: number | null) => (n === null ? "—" : formatCurrency(n));

/** WHY the system recommends (or doesn't recommend) this product: every LIVE it
 *  sold in, with the historical cost snapshot, plus the reasoning behind the
 *  suggested quantity. Forward-looking supplier cost is shown separately and
 *  never changes a historical number. */
export function ReorderDrilldownModal({ row, windowKey, onClose }: { row: ReorderRow; windowKey: WindowKey; onClose: () => void }) {
  const [data, setData] = useState<DrilldownResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/reorder-intelligence/${row.productId}?window=${windowKey}`, { cache: "no-store" })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) setError(body?.error ?? "Could not load this product's history.");
        else setData(body as DrilldownResponse);
      })
      .catch(() => !cancelled && setError("Network error."));
    return () => {
      cancelled = true;
    };
  }, [row.productId, windowKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const windowLabel = WINDOWS.find((w) => w.key === windowKey)?.label ?? windowKey;
  const fwd = data?.forward ?? row.forward ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="glass-panel max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-ld-muted">{windowLabel}</p>
            <h2 className="mt-1 text-lg font-semibold text-ld-white">{row.name}</h2>
            <p className="text-xs text-ld-muted">
              SKU {row.sku || "—"}
              {row.barcode && row.barcode !== row.sku ? ` · ${row.barcode}` : ""} · {row.bucket} · score {row.score}
            </p>
          </div>
          <Link href={`/pricing/products/${row.productId}`} className="shrink-0 text-xs font-semibold text-ld-cyan hover:underline">
            Pricing / Ordering →
          </Link>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Units", String(row.units)],
            ["GMV", formatCurrency(row.gmv)],
            ["Profit", money(row.profit)],
            ["Avg sale / unit", formatCurrency(row.avgSellingPrice)],
            ["Avg unit cost", money(row.avgUnitCost)],
            ["Profit / unit", money(row.profitPerUnit)],
            ["Margin", row.margin === null ? "—" : `${(row.margin * 100).toFixed(1)}%`],
            ["In stock now", String(row.stock)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-ld-border bg-ld-bg-elevated p-3 text-center">
              <p className="text-[10px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
              <p className="mt-0.5 font-display text-base font-extrabold text-ld-white">{value}</p>
            </div>
          ))}
        </div>

        {row.flag && <p className="mt-3 text-sm font-semibold text-ld-cyan">{row.flag}</p>}
        {row.warnings.map((w) => (
          <p key={w} className="mt-2 rounded-lg border border-ld-amber/40 bg-ld-amber/10 px-3 py-2 text-xs text-ld-amber">
            {w}
          </p>
        ))}

        <div className="mt-4 rounded-xl border border-ld-border p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-ld-muted">Suggested reorder</p>
          <p className="mt-1 font-display text-xl font-extrabold text-ld-white">{row.suggestedQty > 0 ? `${row.suggestedQty} units` : "No reorder suggested"}</p>
          <p className="mt-1 text-xs text-ld-muted">{row.suggestedReason}</p>
          <p className="mt-1 text-xs text-ld-muted">
            Sold in {row.livesSold} of {row.applicableLives} applicable LIVEs ({row.confidence} confidence). This is a suggestion only — it does not create a purchase order.
          </p>
        </div>

        <div className="mt-4 rounded-xl border border-ld-amber/40 p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-ld-amber">Forward-looking purchasing guidance — not history</p>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              ["Historical avg sale", formatCurrency(row.avgSellingPrice)],
              ["Historical avg cost", money(row.avgUnitCost)],
              ["Historical profit / unit", money(row.profitPerUnit)],
              ["Current best supplier cost", !data ? "…" : fwd && fwd.currentBestSupplierCost !== null ? formatCurrency(fwd.currentBestSupplierCost) : "none"],
              ["Projected profit / unit", fwd?.projectedProfitPerUnit != null ? money(fwd.projectedProfitPerUnit) : "—"],
              ["Projected margin", fwd?.projectedMargin != null ? `${(fwd.projectedMargin * 100).toFixed(1)}%` : "—"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-ld-border bg-ld-bg-elevated p-2.5 text-center">
                <p className="text-[10px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
                <p className="mt-0.5 text-sm font-extrabold text-ld-white">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-ld-white">
            Target maximum buy cost: <strong className="text-ld-cyan">{formatCurrency(row.maxBuyCost)}</strong>
            <span className="text-xs text-ld-muted">
              {" "}
              = historical avg sale {formatCurrency(row.avgSellingPrice)} × (1 − {Math.round(TARGET_GROSS_MARGIN * 100)}% target margin)
            </span>
          </p>
          {fwd && <p className="mt-1 text-xs text-ld-muted">{fwd.message}</p>}
          {fwd?.supplierName && <p className="mt-1 text-[11px] text-ld-muted">Best current actionable offer: {fwd.supplierName}.</p>}
          <p className="mt-2 text-[11px] text-ld-muted">The supplier cost is only a projection. Historical cost and profit above always use each sale&apos;s own cost snapshot and are never rewritten by it, and it does not change the Reorder Score.</p>
        </div>

        <div className="mt-5">
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-ld-muted">Every LIVE it sold in</p>
          {error && <p className="text-sm text-ld-red">{error}</p>}
          {!data && !error && <p className="animate-pulse text-sm text-ld-muted">Loading…</p>}
          {data && data.sessions.length === 0 && <p className="text-sm text-ld-muted">No sales in this period.</p>}
          <div className="space-y-2">
            {data?.sessions.map((s) => (
              <div key={s.sessionId} className="rounded-xl border border-ld-border bg-ld-bg-elevated p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-ld-white">
                    {formatDate(s.startedAt)} — {s.sessionName}
                  </p>
                  <p className="text-xs text-ld-muted">
                    {s.units} unit{s.units === 1 ? "" : "s"} · avg {formatCurrency(s.avgPrice)} · cost {s.avgUnitCost === null ? "—" : formatCurrency(s.avgUnitCost)} ·{" "}
                    <strong className={s.profit !== null && s.profit < 0 ? "text-ld-red" : "text-ld-green"}>{s.profit === null ? "profit —" : `${formatCurrency(s.profit)} profit`}</strong>
                  </p>
                </div>
                <p className="mt-1 text-[11px] text-ld-muted">
                  {s.orders.map((o) => `${o.liveOrderNumber != null ? `#${o.liveOrderNumber} ` : ""}${formatCurrency(o.price)}${o.quantity > 1 ? ` ×${o.quantity}` : ""}${o.landedCostAtSale == null ? " (no cost)" : ""}`).join(" · ")}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-lg border border-ld-border px-4 py-2 text-sm font-semibold text-ld-white hover:bg-ld-bg-elevated">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
