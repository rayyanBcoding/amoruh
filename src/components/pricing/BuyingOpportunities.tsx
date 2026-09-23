"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";

interface CompetitiveEntry {
  identityKey: string;
  isCarried: boolean;
  brand: string;
  name: string;
  bestPriceUsd: number;
  secondBestPriceUsd: number | null;
  perUnitAdvantageUsd: number | null;
  perUnitAdvantagePct: number | null;
  eligibleSupplierCount: number;
  isTie: boolean;
  winningSupplierIds: string[];
  offers: { supplierId: string; supplierName: string; priceUsd: number; quantity: number | null }[];
}

interface SingleSupplierEntry {
  identityKey: string;
  isCarried: boolean;
  brand: string;
  name: string;
  supplierName: string;
  priceUsd: number;
}

type SortKey = "priceDiffUsd" | "priceDiffPct" | "brand" | "price" | "availability" | "name";
type CarriedFilter = "" | "carried" | "not_carried";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "priceDiffUsd", label: "$ Savings" },
  { key: "priceDiffPct", label: "% Savings" },
  { key: "price", label: "Price" },
  { key: "availability", label: "Availability" },
  { key: "brand", label: "Brand" },
  { key: "name", label: "Name" },
];

/** Buying Opportunities — a full, paginated, sortable, filterable browse
 *  of every eligible competitive product (never a curated shortlist),
 *  backed by /api/pricing/buying-opportunities which sorts/filters/
 *  paginates server-side over the same cached leaderboard data Supplier
 *  Price Leaders uses. Single-supplier products are a separate,
 *  distinctly-labeled view — never implied as a "win" or as profitable. */
export function BuyingOpportunities() {
  const router = useRouter();
  const [view, setView] = useState<"competitive" | "single_supplier">("competitive");
  const [sort, setSort] = useState<SortKey>("priceDiffUsd");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [brand, setBrand] = useState("");
  const [carried, setCarried] = useState<CarriedFilter>("");
  const [savingsThreshold, setSavingsThreshold] = useState("");
  const [cursor, setCursor] = useState(0);
  const [items, setItems] = useState<(CompetitiveEntry | SingleSupplierEntry)[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ view, sort, dir, cursor: String(cursor) });
    if (brand.trim()) params.set("brand", brand.trim());
    if (carried) params.set("carried", carried);
    if (savingsThreshold.trim()) params.set("savingsThreshold", savingsThreshold.trim());
    const handle = setTimeout(() => {
      setLoading(true);
      fetch(`/api/pricing/buying-opportunities?${params.toString()}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (!body) return;
          setItems(body.items ?? []);
          setTotal(body.total ?? 0);
          setNextCursor(body.nextCursor ?? null);
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [view, sort, dir, brand, carried, savingsThreshold, cursor]);

  const openDetail = (e: CompetitiveEntry | SingleSupplierEntry) =>
    router.push(e.isCarried ? `/pricing/products/${e.identityKey}` : `/pricing/reference-products/${e.identityKey}`);

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-bold text-ld-white">Buying Opportunities</h2>
        <div className="flex items-center gap-1 rounded-xl bg-ld-bg-elevated p-1">
          {(["competitive", "single_supplier"] as const).map((v) => (
            <button
              key={v}
              onClick={() => {
                setView(v);
                setCursor(0);
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                view === v ? "bg-ld-purple text-ld-white" : "text-ld-muted hover:text-ld-white"
              }`}
            >
              {v === "competitive" ? "Competitive" : "Single-Supplier Only"}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={brand}
          onChange={(e) => {
            setBrand(e.target.value);
            setCursor(0);
          }}
          placeholder="Filter by brand…"
          className="rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-1.5 text-xs text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple"
        />
        <select
          value={carried}
          onChange={(e) => {
            setCarried(e.target.value as CarriedFilter);
            setCursor(0);
          }}
          className="rounded-lg border border-ld-border bg-ld-bg-elevated px-2 py-1.5 text-xs text-ld-white outline-none focus:border-ld-purple"
        >
          <option value="">Carried + Not Carried</option>
          <option value="carried">Carried only</option>
          <option value="not_carried">Not Carried only</option>
        </select>
        {view === "competitive" && (
          <input
            value={savingsThreshold}
            onChange={(e) => {
              setSavingsThreshold(e.target.value);
              setCursor(0);
            }}
            type="number"
            min={0}
            placeholder="Min $ savings…"
            className="w-32 rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-1.5 text-xs text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple"
          />
        )}
        {view === "competitive" &&
          SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => {
                if (sort === s.key) setDir(dir === "desc" ? "asc" : "desc");
                else {
                  setSort(s.key);
                  setDir("desc");
                }
                setCursor(0);
              }}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide ${
                sort === s.key ? "bg-ld-purple/20 text-ld-purple" : "text-ld-muted hover:text-ld-white"
              }`}
            >
              {s.label}
              {sort === s.key && (dir === "desc" ? " ▾" : " ▴")}
            </button>
          ))}
        <p className="ml-auto text-xs text-ld-muted">{total.toLocaleString()} products</p>
      </div>

      <div className="space-y-1.5">
        {items.map((item) => {
          const isCompetitive = "isTie" in item;
          return (
            <button
              key={item.identityKey}
              onClick={() => openDetail(item)}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-ld-bg-elevated px-4 py-2.5 text-left text-sm hover:bg-ld-border/30"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ld-white">
                  {item.brand} {item.name}
                </p>
                <p className="text-xs text-ld-muted">
                  {isCompetitive
                    ? `Best: ${formatCurrency((item as CompetitiveEntry).bestPriceUsd)} · Next: ${
                        (item as CompetitiveEntry).secondBestPriceUsd !== null ? formatCurrency((item as CompetitiveEntry).secondBestPriceUsd!) : "—"
                      } · ${(item as CompetitiveEntry).eligibleSupplierCount} suppliers`
                    : `${(item as SingleSupplierEntry).supplierName} · ${formatCurrency((item as SingleSupplierEntry).priceUsd)} · only supplier`}
                </p>
              </div>
              <div className="shrink-0 text-right">
                {isCompetitive && (item as CompetitiveEntry).isTie ? (
                  <span className="rounded-full bg-ld-amber/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-ld-amber">Tied</span>
                ) : isCompetitive ? (
                  <span className="text-sm font-semibold text-ld-green">
                    {(item as CompetitiveEntry).perUnitAdvantageUsd !== null ? formatCurrency((item as CompetitiveEntry).perUnitAdvantageUsd!) : "—"}
                    {(item as CompetitiveEntry).perUnitAdvantagePct !== null && (
                      <span className="ml-1 text-ld-muted">({(item as CompetitiveEntry).perUnitAdvantagePct}%)</span>
                    )}
                  </span>
                ) : (
                  <span className="rounded-full bg-ld-purple/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-ld-purple">
                    Single Supplier
                  </span>
                )}
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-ld-muted">{item.isCarried ? "Carried" : "Not Carried"}</p>
              </div>
            </button>
          );
        })}
        {!loading && items.length === 0 && <p className="py-6 text-center text-sm text-ld-muted">No matching products.</p>}
        {loading && <p className="py-2 text-center text-xs text-ld-muted">Loading…</p>}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-ld-muted">
        <button disabled={cursor === 0} onClick={() => setCursor(Math.max(0, cursor - 50))} className="disabled:opacity-30">
          ← Previous
        </button>
        <button disabled={nextCursor === null} onClick={() => nextCursor !== null && setCursor(nextCursor)} className="disabled:opacity-30">
          Next →
        </button>
      </div>
      {view === "competitive" && (
        <p className="mt-3 text-[11px] text-ld-muted">
          $/% savings are per-unit price advantages only — not a projected or realized order total. A low supplier price alone doesn&apos;t imply
          profitability; selling price, fees, shipping and demand aren&apos;t reflected here.
        </p>
      )}
    </div>
  );
}
