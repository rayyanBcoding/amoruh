"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ReorderResult, ReorderRow, Bucket } from "@/lib/reorder-intelligence";
import { DEFAULT_WINDOW, WINDOWS, type WindowKey } from "@/lib/reorder-config";
import { formatCurrency } from "@/lib/format";
import { ReorderDrilldownModal } from "@/components/dashboard/ReorderDrilldownModal";

type SortKey = "score" | "units" | "profit" | "profitPerUnit" | "margin" | "consistency" | "recent" | "stock";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "score", label: "Best to Reorder" },
  { key: "units", label: "Units Sold" },
  { key: "profit", label: "Total Profit" },
  { key: "profitPerUnit", label: "Profit per Unit" },
  { key: "margin", label: "Margin %" },
  { key: "consistency", label: "Most Consistent" },
  { key: "recent", label: "Most Recent" },
  { key: "stock", label: "Lowest Inventory" },
];

const BUCKET_STYLE: Record<Bucket, string> = {
  "Hot + Profitable": "bg-ld-green/15 text-ld-green",
  "High Demand / Thin Margin": "bg-ld-amber/15 text-ld-amber",
  "High Demand / Losing Money": "bg-ld-red/15 text-ld-red",
  "High Profit / Lower Frequency": "bg-ld-cyan/15 text-ld-cyan",
  "Steady Seller": "bg-ld-purple/15 text-ld-purple",
  "Weak Performer": "bg-ld-border/40 text-ld-muted",
  "Cost Unknown": "bg-ld-amber/15 text-ld-amber",
  "New / Not Enough Data": "bg-ld-border/40 text-ld-muted",
};

const BUCKETS: Bucket[] = [
  "Hot + Profitable",
  "Steady Seller",
  "High Profit / Lower Frequency",
  "High Demand / Thin Margin",
  "High Demand / Losing Money",
  "Cost Unknown",
  "Weak Performer",
  "New / Not Enough Data",
];

const money = (n: number | null) => (n === null ? "—" : formatCurrency(n));

function SummaryCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ld-border bg-ld-bg-elevated p-4">
      <p className="text-[10px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/** Click a score to see exactly how it was built — never a black box. */
function ScoreCell({ row }: { row: ReorderRow }) {
  const [open, setOpen] = useState(false);
  const b = row.breakdown;
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
        title="Click for the score breakdown"
        className="rounded-md bg-ld-purple/15 px-2 py-0.5 font-display text-sm font-extrabold text-ld-white hover:bg-ld-purple/30"
      >
        {row.score}
      </button>
      {open && (
        <span className="absolute right-0 top-full z-30 mt-1 block w-60 rounded-xl border border-ld-border bg-ld-bg p-3 text-left text-xs shadow-xl" onClick={(e) => e.stopPropagation()}>
          <span className="block font-display text-sm font-extrabold text-ld-white">Reorder Score: {row.score}</span>
          <span className="mt-1.5 block space-y-0.5 text-ld-muted">
            <span className="flex justify-between"><span>Demand ({Math.round(b.weights.demand * 100)}%)</span><strong className="text-ld-white">{b.demand}</strong></span>
            <span className="flex justify-between">
              <span>Profit ({Math.round(b.weights.profit * 100)}%)</span>
              <strong className="text-ld-white">{b.profit === null ? "left out" : b.profit}</strong>
            </span>
            <span className="flex justify-between"><span>Consistency ({Math.round(b.weights.consistency * 100)}%)</span><strong className="text-ld-white">{b.consistency}</strong></span>
          </span>
          {b.profit === null && (
            <span className="mt-1.5 block text-ld-amber">Cost unknown: profit is left out and Demand + Consistency are re-weighted — lower confidence.</span>
          )}
          {b.capped && <span className="mt-1.5 block text-ld-red">Capped from {b.uncapped}: it loses money, so it can&apos;t rank as a top reorder.</span>}
          <span className="mt-1.5 block text-ld-muted">Demand and Profit are percentile ranks among this period&apos;s products; Consistency is LIVEs sold ÷ applicable LIVEs, scaled by evidence ({row.confidence} confidence).</span>
        </span>
      )}
    </span>
  );
}

function SortHeader({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-ld-muted">{children}</th>;
}

export function ReorderIntelligencePanel() {
  const [windowKey, setWindowKey] = useState<WindowKey>(DEFAULT_WINDOW);
  const [data, setData] = useState<ReorderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>("score");
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState<Bucket | "all">("all");
  const [openProduct, setOpenProduct] = useState<ReorderRow | null>(null);

  const load = useCallback(async (w: WindowKey) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/reorder-intelligence?window=${w}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? "Could not load Reorder Intelligence.");
        return;
      }
      setError(null);
      setData(body as ReorderResult);
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // deferred a tick — react-hooks/set-state-in-effect flags a direct call
    Promise.resolve().then(() => void load(windowKey));
  }, [load, windowKey]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const filtered = data.rows.filter((r) => {
      if (bucket !== "all" && r.bucket !== bucket) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q) || r.barcode.toLowerCase().includes(q);
    });
    const nullLast = (v: number | null, dir: 1 | -1) => (v === null ? -Infinity * dir : v);
    const cmp: Record<SortKey, (a: ReorderRow, b: ReorderRow) => number> = {
      score: (a, b) => b.score - a.score || b.units - a.units,
      units: (a, b) => b.units - a.units,
      profit: (a, b) => nullLast(b.profit, 1) - nullLast(a.profit, 1),
      profitPerUnit: (a, b) => nullLast(b.profitPerUnit, 1) - nullLast(a.profitPerUnit, 1),
      margin: (a, b) => nullLast(b.margin, 1) - nullLast(a.margin, 1),
      consistency: (a, b) => b.consistency - a.consistency || b.units - a.units,
      recent: (a, b) => b.lastSoldAt.localeCompare(a.lastSoldAt),
      stock: (a, b) => a.stock - b.stock || b.score - a.score,
    };
    return [...filtered].sort(cmp[sort]);
  }, [data, query, bucket, sort]);

  const s = data?.summary;

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Reorder Intelligence</h3>
          <p className="mt-0.5 text-xs text-ld-muted">
            Ranked from your real LIVE sales (active orders only, historical cost at sale). Informational — nothing here creates a purchase order or changes inventory.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWindowKey(w.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold ${windowKey === w.key ? "bg-ld-purple text-ld-white" : "bg-ld-bg-elevated text-ld-muted hover:text-ld-white"}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mb-3 text-sm font-medium text-ld-red">{error}</p>}
      {!data && loading && <p className="animate-pulse py-10 text-center text-ld-muted">Crunching your LIVE history…</p>}

      {data && s && (
        <>
          <div className={`grid grid-cols-1 gap-3 transition-opacity sm:grid-cols-2 xl:grid-cols-4 ${loading ? "opacity-60" : ""}`}>
            <SummaryCard label="Top Reorder Candidates">
              {s.topCandidates.length === 0 ? (
                <p className="text-sm text-ld-muted">None yet in this period.</p>
              ) : (
                <ol className="space-y-0.5 text-sm">
                  {s.topCandidates.map((r, i) => (
                    <li key={r.productId} className="flex justify-between gap-2">
                      <button type="button" onClick={() => setOpenProduct(r)} className="truncate text-left font-semibold text-ld-white hover:text-ld-cyan">
                        {i + 1}. {r.name}
                        {r.costUnknown && <span title="Cost unknown — lower-confidence ranking" className="ml-1 text-ld-amber">⚠</span>}
                      </button>
                      <span className="shrink-0 text-xs text-ld-muted">{r.score}</span>
                    </li>
                  ))}
                </ol>
              )}
            </SummaryCard>
            <SummaryCard label="Total LIVE Gross Profit">
              <p className="font-display text-2xl font-extrabold text-ld-green">{formatCurrency(s.totalProfit)}</p>
              <p className="text-xs text-ld-muted">
                {formatCurrency(s.totalGmv)} GMV · {s.totalUnits} units · {s.sessionsInWindow} LIVEs
                {s.salesMissingCost > 0 && <span className="text-ld-amber"> · excl. {s.salesMissingCost} sales without a cost</span>}
              </p>
            </SummaryCard>
            <SummaryCard label="Most Consistent Seller">
              {s.mostConsistent ? (
                <>
                  <button type="button" onClick={() => setOpenProduct(s.mostConsistent)} className="text-left text-sm font-semibold text-ld-white hover:text-ld-cyan">
                    {s.mostConsistent.name}
                  </button>
                  <p className="text-xs text-ld-muted">
                    Sold in {s.mostConsistent.livesSold} of {s.mostConsistent.applicableLives} LIVEs · {s.mostConsistent.units} units
                  </p>
                </>
              ) : (
                <p className="text-sm text-ld-muted">Not enough history.</p>
              )}
            </SummaryCard>
            <SummaryCard label="Highest Profit Product">
              {s.highestProfitProduct ? (
                <>
                  <button type="button" onClick={() => setOpenProduct(s.highestProfitProduct)} className="text-left text-sm font-semibold text-ld-white hover:text-ld-cyan">
                    {s.highestProfitProduct.name}
                  </button>
                  <p className="text-xs text-ld-muted">
                    {money(s.highestProfitProduct.profit)} on {s.highestProfitProduct.units} units
                  </p>
                </>
              ) : (
                <p className="text-sm text-ld-muted">No profit data yet.</p>
              )}
            </SummaryCard>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search product, SKU or barcode"
              aria-label="Search products"
              className="w-64 rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
            />
            <label className="flex items-center gap-1.5 text-xs font-semibold text-ld-muted">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rounded-lg border border-ld-border bg-ld-bg-elevated px-2 py-2 text-sm text-ld-white outline-none">
                {SORTS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-ld-muted">
              Bucket
              <select value={bucket} onChange={(e) => setBucket(e.target.value as Bucket | "all")} className="rounded-lg border border-ld-border bg-ld-bg-elevated px-2 py-2 text-sm text-ld-white outline-none">
                <option value="all">All buckets</option>
                {BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-xs text-ld-muted">{rows.length} products</span>
          </div>

          <div className="mt-3 overflow-x-auto rounded-xl border border-ld-border">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="border-b border-ld-border bg-ld-bg-elevated">
                <tr>
                  <SortHeader>Product</SortHeader>
                  <SortHeader>Units</SortHeader>
                  <SortHeader>LIVEs sold</SortHeader>
                  <SortHeader>GMV</SortHeader>
                  <SortHeader>Profit</SortHeader>
                  <SortHeader>Profit / unit</SortHeader>
                  <SortHeader>Margin</SortHeader>
                  <SortHeader>Consistency</SortHeader>
                  <SortHeader>Stock</SortHeader>
                  <SortHeader>Score</SortHeader>
                  <SortHeader>Suggested</SortHeader>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.productId} onClick={() => setOpenProduct(r)} className="cursor-pointer border-b border-ld-border/40 last:border-0 hover:bg-ld-bg-elevated">
                    <td className="max-w-[320px] px-3 py-2">
                      <p className="truncate font-semibold text-ld-white">{r.name}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${BUCKET_STYLE[r.bucket]}`}>{r.bucket}</span>
                        {r.warnings.length > 0 && (
                          <span title={r.warnings.join("\n")} className="cursor-help text-[10px] font-bold uppercase text-ld-amber">
                            ⚠ {r.costUnknown ? "cost unknown" : r.confidence === "full" ? "check" : "lower confidence"}
                          </span>
                        )}
                        {r.flag && <span className="text-[10px] font-semibold text-ld-cyan">{r.flag}</span>}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-ld-white">{r.units}</td>
                    <td className="px-3 py-2 text-ld-white">
                      {r.livesSold}/{r.applicableLives}
                    </td>
                    <td className="px-3 py-2 text-ld-white">{formatCurrency(r.gmv)}</td>
                    <td className={`px-3 py-2 font-semibold ${r.profit !== null && r.profit < 0 ? "text-ld-red" : "text-ld-green"}`}>{money(r.profit)}</td>
                    <td className="px-3 py-2 text-ld-white">{money(r.profitPerUnit)}</td>
                    <td className="px-3 py-2 text-ld-white">{r.margin === null ? "—" : `${Math.round(r.margin * 100)}%`}</td>
                    <td className="px-3 py-2 text-ld-white" title={`${r.confidence} confidence`}>
                      {Math.round(r.consistency)}%
                    </td>
                    <td className="px-3 py-2 text-ld-white">{r.stock}</td>
                    <td className="px-3 py-2">
                      <ScoreCell row={r} />
                    </td>
                    <td className="px-3 py-2 font-semibold text-ld-cyan">{r.suggestedQty > 0 ? r.suggestedQty : "—"}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-8 text-center text-sm text-ld-muted">
                      No products match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {(data.dataQuality.lookAlikeGroups.length > 0 || data.dataQuality.deletedProductIds.length > 0) && (
            <div className="mt-3 rounded-xl border border-ld-amber/40 bg-ld-amber/10 p-3 text-xs text-ld-muted">
              <p className="font-bold uppercase tracking-widest text-ld-amber">Data quality</p>
              <p className="mt-1">These sold under separate product IDs but have near-identical names. They are reported separately — never combined in the numbers:</p>
              <ul className="mt-1 list-disc pl-5">
                {data.dataQuality.lookAlikeGroups.map((g) => (
                  <li key={g.productIds.join("+")}>
                    {g.names.map((n, i) => (
                      <span key={g.productIds[i]}>
                        {i > 0 && " ↔ "}
                        <Link href={`/inventory/${g.productIds[i]}`} className="text-ld-cyan hover:underline">
                          {n}
                        </Link>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
              {data.dataQuality.deletedProductIds.length > 0 && <p className="mt-1">{data.dataQuality.deletedProductIds.length} sold product(s) no longer exist in the catalog.</p>}
            </div>
          )}
        </>
      )}

      {openProduct && <ReorderDrilldownModal row={openProduct} windowKey={windowKey} onClose={() => setOpenProduct(null)} />}
    </div>
  );
}
