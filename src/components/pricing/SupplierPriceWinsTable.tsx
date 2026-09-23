"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";

interface WinEntry {
  identityKey: string;
  isCarried: boolean;
  brand: string;
  name: string;
  sizeMl: number | null;
  concentration: string | null;
  productForm: string;
  upc: string;
  ean: string;
  isTie: boolean;
  bestPriceUsd: number;
  secondBestPriceUsd: number | null;
  perUnitAdvantageUsd: number | null;
  perUnitAdvantagePct: number | null;
  eligibleSupplierCount: number;
}

type SortKey = "priceDiffUsd" | "priceDiffPct" | "brand" | "price" | "availability" | "name";
type FilterKey = "all" | "carried" | "not_carried";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "priceDiffUsd", label: "$ Savings" },
  { key: "priceDiffPct", label: "% Savings" },
  { key: "brand", label: "Brand" },
  { key: "price", label: "Price" },
  { key: "availability", label: "Availability" },
  { key: "name", label: "Name" },
];

/** The supplier detail page's "Price Wins" drill-down — every Master
 *  Product this supplier currently wins on (from the same cached
 *  leaderboard Supplier Price Leaders uses), sortable and filterable
 *  entirely client-side (this supplier's own win-list is bounded, same
 *  idiom as InventoryTable.tsx). Every row opens the EXISTING Master
 *  Product comparison detail page — never a new duplicate page. */
export function SupplierPriceWinsTable({ supplierId, supplierName }: { supplierId: string; supplierName: string }) {
  const router = useRouter();
  const [products, setProducts] = useState<WinEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("priceDiffUsd");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [productForm, setProductForm] = useState("");

  useEffect(() => {
    fetch(`/api/pricing/leaderboard?supplierId=${supplierId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setProducts(body?.products ?? []))
      .catch(() => setProducts([]));
  }, [supplierId]);

  const productForms = useMemo(() => [...new Set((products ?? []).map((p) => p.productForm))].sort(), [products]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = products ?? [];
    if (filter === "carried") rows = rows.filter((p) => p.isCarried);
    if (filter === "not_carried") rows = rows.filter((p) => !p.isCarried);
    if (productForm) rows = rows.filter((p) => p.productForm === productForm);
    if (q) rows = rows.filter((p) => `${p.brand} ${p.name}`.toLowerCase().includes(q));
    const sorted = [...rows].sort((a, b) => {
      let cmp = 0;
      switch (sort) {
        case "priceDiffUsd":
          cmp = (a.perUnitAdvantageUsd ?? -1) - (b.perUnitAdvantageUsd ?? -1);
          break;
        case "priceDiffPct":
          cmp = (a.perUnitAdvantagePct ?? -1) - (b.perUnitAdvantagePct ?? -1);
          break;
        case "brand":
          cmp = a.brand.localeCompare(b.brand);
          break;
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "price":
          cmp = a.bestPriceUsd - b.bestPriceUsd;
          break;
        case "availability":
          cmp = a.eligibleSupplierCount - b.eligibleSupplierCount;
          break;
      }
      return cmp * (dir === "desc" ? -1 : 1);
    });
    return sorted;
  }, [products, query, sort, dir, filter, productForm]);

  return (
    <div className="glass-panel mb-6 rounded-2xl p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-ld-white">Price Wins</h2>
        <p className="text-xs text-ld-muted">
          {products === null ? "Loading…" : `${filtered.length.toLocaleString()} of ${products.length.toLocaleString()} products ${supplierName} wins on`}
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by brand or name…"
          className="rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-1.5 text-xs text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterKey)}
          className="rounded-lg border border-ld-border bg-ld-bg-elevated px-2 py-1.5 text-xs text-ld-white outline-none focus:border-ld-purple"
        >
          <option value="all">Carried + Not Carried</option>
          <option value="carried">Carried only</option>
          <option value="not_carried">Not Carried only</option>
        </select>
        {productForms.length > 1 && (
          <select
            value={productForm}
            onChange={(e) => setProductForm(e.target.value)}
            className="rounded-lg border border-ld-border bg-ld-bg-elevated px-2 py-1.5 text-xs text-ld-white outline-none focus:border-ld-purple"
          >
            <option value="">All product forms</option>
            {productForms.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
        {SORTS.map((s) => (
          <button
            key={s.key}
            onClick={() => {
              if (sort === s.key) setDir(dir === "desc" ? "asc" : "desc");
              else {
                setSort(s.key);
                setDir("desc");
              }
            }}
            className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide ${
              sort === s.key ? "bg-ld-purple/20 text-ld-purple" : "text-ld-muted hover:text-ld-white"
            }`}
          >
            {s.label}
            {sort === s.key && (dir === "desc" ? " ▾" : " ▴")}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        {filtered.map((p) => (
          <button
            key={p.identityKey}
            onClick={() => router.push(p.isCarried ? `/pricing/products/${p.identityKey}` : `/pricing/reference-products/${p.identityKey}`)}
            className="flex w-full items-center justify-between gap-3 rounded-xl bg-ld-bg-elevated px-4 py-2.5 text-left text-sm hover:bg-ld-border/30"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-ld-white">
                {p.brand} {p.name}
              </p>
              <p className="text-xs text-ld-muted">
                {p.sizeMl ? `${p.sizeMl}ml ` : ""}
                {p.concentration ?? ""} · Best: {formatCurrency(p.bestPriceUsd)} · {p.eligibleSupplierCount} suppliers
              </p>
            </div>
            <div className="shrink-0 text-right">
              {p.isTie ? (
                <span className="rounded-full bg-ld-amber/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-ld-amber">Tied</span>
              ) : (
                <span className="text-sm font-semibold text-ld-green">
                  {p.perUnitAdvantageUsd !== null ? formatCurrency(p.perUnitAdvantageUsd) : "—"}
                  {p.perUnitAdvantagePct !== null && <span className="ml-1 text-ld-muted">({p.perUnitAdvantagePct}%)</span>}
                </span>
              )}
              <p className="mt-0.5 text-[10px] uppercase tracking-wide text-ld-muted">{p.isCarried ? "Carried" : "Not Carried"}</p>
            </div>
          </button>
        ))}
        {products !== null && filtered.length === 0 && <p className="py-6 text-center text-sm text-ld-muted">No matching products.</p>}
      </div>
    </div>
  );
}
