"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Product } from "@/lib/types";
import { BottleImage } from "@/components/BottleImage";
import { StatusBadge } from "@/components/Badge";
import { formatCurrency } from "@/lib/format";

type SortKey = "brand" | "name" | "inventory" | "retailPrice" | "marketPrice";

export function InventoryTable({ products }: { products: Product[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("brand");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = !q
      ? products
      : products.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.brand.toLowerCase().includes(q) ||
            p.sku.toLowerCase().includes(q) ||
            p.barcode.toLowerCase().includes(q) ||
            p.tiktokListing.toLowerCase().includes(q) ||
            p.shelf.toLowerCase().includes(q)
        );
    return [...rows].sort((a, b) => {
      if (typeof a[sortKey] === "number") {
        return (b[sortKey] as number) - (a[sortKey] as number);
      }
      return String(a[sortKey]).localeCompare(String(b[sortKey]));
    });
  }, [products, query, sortKey]);

  const columns: { key: SortKey | null; label: string }[] = [
    { key: null, label: "" },
    { key: null, label: "Internal SKU" },
    { key: "brand", label: "Brand" },
    { key: "name", label: "Product" },
    { key: null, label: "Size" },
    { key: "inventory", label: "Inventory" },
    { key: null, label: "Shelf" },
    { key: "retailPrice", label: "Retail" },
    { key: "marketPrice", label: "Market" },
    { key: null, label: "TikTok Listing Name" },
    { key: null, label: "Status" },
  ];

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search SKU, brand, product, shelf, TikTok listing…"
          className="w-full max-w-md rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-2.5 text-sm text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple focus:ring-4 focus:ring-ld-purple/15"
        />
        <p className="text-sm text-ld-muted">{filtered.length} products</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-separate border-spacing-y-2 text-sm">
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th
                  key={i}
                  onClick={() => col.key && setSortKey(col.key)}
                  className={`px-3 pb-1 text-left text-[11px] font-bold uppercase tracking-widest text-ld-muted ${
                    col.key ? "cursor-pointer select-none hover:text-ld-white" : ""
                  }`}
                >
                  {col.label}
                  {col.key === sortKey && " ▾"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr
                key={p.id}
                onClick={() => router.push(`/inventory/${p.id}`)}
                className="cursor-pointer rounded-xl bg-ld-bg-elevated transition-colors hover:bg-ld-border/30"
              >
                <td className="rounded-l-xl px-3 py-2.5">
                  <BottleImage src={p.image} alt={p.name} color={p.color} glow={false} className="h-9 w-9" />
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-ld-cyan">{p.sku}</td>
                <td className="px-3 py-2.5 font-medium text-ld-white">{p.brand}</td>
                <td className="px-3 py-2.5 text-ld-white">{p.name}</td>
                <td className="px-3 py-2.5 text-ld-muted">{p.size}</td>
                <td className={`px-3 py-2.5 font-semibold ${p.inventory <= 3 ? "text-ld-red" : "text-ld-white"}`}>
                  {p.inventory}
                </td>
                <td className="px-3 py-2.5 text-ld-muted">{p.shelf}</td>
                <td className="px-3 py-2.5 text-ld-muted">{formatCurrency(p.retailPrice)}</td>
                <td className="px-3 py-2.5 text-ld-white">{formatCurrency(p.marketPrice)}</td>
                <td className="max-w-[220px] truncate px-3 py-2.5 text-ld-muted">{p.tiktokListing}</td>
                <td className="rounded-r-xl px-3 py-2.5">
                  <StatusBadge status={p.status} />
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="py-10 text-center text-ld-muted">
                  No products match &ldquo;{query}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
