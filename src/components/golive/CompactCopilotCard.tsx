"use client";
import { useState } from "react";
import type { Product } from "@/lib/types";
import type { CurrentProductFinancialsView, RecentSaleView } from "@/context/LiveSessionContext";
import type { CopilotHistory } from "@/lib/live-copilot";
import { copilotView } from "@/lib/live-copilot";
import { formatCurrency } from "@/lib/format";
import { BottleImage } from "@/components/BottleImage";
import { LiveNotesCard } from "@/components/LiveNotesCard";
import { Button } from "@/components/Button";

export function CompactCopilotCard({ product, financials, history, recent = [], isTest = false }: {
  product: Product; financials: CurrentProductFinancialsView | null; history: CopilotHistory; recent?: RecentSaleView[]; isTest?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const view = copilotView(product, financials, history);
  const sales = recent.filter((v) => v.product?.id === product.id && v.presentation.outcome === "sold" && v.sale && v.sale.status !== "canceled" && v.sale.status !== "refunded");
  const row = view.history;
  const money = (n: number | null | undefined) => n != null && Number.isFinite(n) ? formatCurrency(n) : "Unavailable";
  return <section aria-label="Current product Copilot" className="space-y-4">
    <h2 className="break-words font-display text-3xl font-extrabold leading-tight text-ld-white lg:text-4xl">
      {view.name} <span className="font-semibold text-ld-muted">· {view.concentration || "Concentration unknown"}</span>
    </h2>
    <p className={`text-xl font-semibold leading-snug lg:text-2xl ${view.notesNeedReview ? "text-ld-amber" : "text-ld-white"}`}>
      {view.notesNeedReview ? "Notes: check before quoting" : view.keyNotes.join(" • ") || "Notes: Not available"}
    </p>
    <div className="space-y-1 font-display text-3xl font-bold leading-tight lg:text-4xl">
      <p className="text-ld-white">Retail: {view.retail ? `${money(view.retail.priceCents! / 100)} (${view.retail.referenceSize})` : "Not verified"}</p>
      <p className="text-ld-cyan">Floor: {view.floor ? money(view.floor.value) : "Review"}</p>
    </div>
    <p role="status" className={`text-xl font-bold lg:text-2xl ${view.status.tone === "warn" ? "text-ld-amber" : view.status.tone === "good" ? "text-ld-green" : "text-ld-muted"}`}>{view.status.label}</p>
    <button type="button" aria-expanded={open} aria-controls={`copilot-details-${product.id}`} onClick={() => setOpen(!open)} className="min-h-11 rounded-lg px-2 py-2 text-base font-semibold text-ld-muted hover:bg-ld-border/40 hover:text-ld-white focus-visible:outline-2 focus-visible:outline-ld-cyan">
      More {open ? "▴" : "▾"}
    </button>
    {open && <div id={`copilot-details-${product.id}`} className="space-y-5 border-t border-ld-border pt-5 text-sm text-ld-white">
      <p className="font-bold text-ld-amber">Operator only · {isTest ? "Test inventory/sales; seller intelligence uses real LIVE history" : "Not shown on TV"}</p>
      <div className="flex flex-wrap items-start gap-5">
        <BottleImage src={product.image} alt={`${product.brand} ${product.name}`} color={product.color} className="h-40 w-32" />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
          <dt>Actual size / condition</dt><dd>{product.size} · {product.condition}</dd>
          <dt>SKU</dt><dd>{product.sku}</dd>
          <dt>{isTest ? "Simulated inventory" : "Current inventory"}</dt><dd>{product.inventory} units</dd>
          <dt>Shelf</dt><dd>{product.shelf || "—"}</dd>
          <dt>Projection / longevity</dt><dd>{product.projection || "—"} / {product.longevity || "—"}</dd>
          <dt>Authenticity flag</dt><dd>{product.authentic ? "Marked authentic" : "Needs review"}</dd>
        </dl>
      </div>
      <LiveNotesCard product={product} size="compact" />
      {product.manualSellingNote && <p className="text-ld-amber">Seller note: {product.manualSellingNote}</p>}
      <div className="space-y-2 rounded-xl border border-ld-amber/30 p-4">
        <h3 className="font-bold">Advisory floor and status</h3>
        <p>{view.status.reason}</p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
          <dt>Actual item cost</dt><dd>{money(financials?.cost)} ({financials?.costSource ?? "unavailable"})</dd>
          <dt>Fee-adjusted break-even</dt><dd>{financials?.breakEven.status === "ok" ? money(financials.breakEven.breakEven) : "Not configured"}</dd>
          <dt>Configured minimum</dt><dd>{money(product.minPrice)}</dd>
          <dt>Last sold</dt><dd>{money(financials?.lastSoldPrice)}</dd>
          <dt>Average auction (all-history metric)</dt><dd>{money(financials?.averageAuction)}</dd>
        </dl>
        <p>{view.floor ? `Floor is the highest of the minimum, break-even, and cost ÷ (1 − ${view.floor.targetMargin * 100}% gross-margin target), rounded up to a whole dollar. Gross-margin floor: ${money(view.floor.marginFloor)}.` : "Floor needs valid item cost, configured break-even and minimum-price data."}</p>
        <p>Per item, advisory only. Full-size retail never sets the floor. Gross margin excludes selling fees; break-even covers configured fees and fixed selling costs. Sale entry rules are unchanged.</p>
      </div>
      <div className="space-y-2">
        <h3 className="font-bold">Real LIVE history · last 5 LIVEs</h3>
        <p>{history.state === "loading" ? "Loading history…" : history.state === "unavailable" ? "History unavailable; no seller-performance label inferred." : row ? `${row.units} units · Average per unit ${money(row.avgSellingPrice)} · Historical gross margin ${row.margin === null ? "unknown" : `${(row.margin * 100).toFixed(1)}%`} · ${row.bucket}` : "No completed non-cancelled sales in this window; no seller-performance label inferred."}</p>
        {row && <><p>Evidence: {row.livesSold} LIVEs sold / {row.applicableLives} applicable LIVEs · Cost coverage {(row.costCoverage * 100).toFixed(0)}%.</p>{row.warnings.map((w) => <p key={w} className="text-ld-amber">{w}</p>)}</>}
        <h4 className="font-semibold">Recent sales in this {isTest ? "test " : ""}session</h4>
        <p className="text-ld-muted">From the existing latest-30-presentation feed; cancelled/refunded records excluded. This is not lifetime history.</p>
        {sales.length ? <ul>{sales.map((v) => <li key={v.presentation.id}>{new Date(v.sale!.soldAt).toLocaleString()} · {v.sale!.quantity ?? 1} units · {money(v.sale!.price)} total</li>)}</ul> : <p>No matching sales in the recent session feed.</p>}
      </div>
      <Button variant="ghost" size="md" onClick={() => window.alert(`Sending "${product.sku}" label to printer… (placeholder)`)}>🖨 Print Label</Button>
    </div>}
  </section>;
}
