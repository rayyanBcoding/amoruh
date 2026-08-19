"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Product } from "@/lib/types";
import { BottleImage } from "@/components/BottleImage";
import { StatusBadge } from "@/components/Badge";
import { formatCurrency } from "@/lib/format";

type SortKey = "brand" | "name" | "inventory" | "retailPrice" | "marketPrice" | "lootPrice";

async function adjustInventory(id: string, action: string, value?: number) {
  const res = await fetch(`/api/products/${id}/inventory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    window.alert(body?.error ?? "Could not update inventory.");
  }
}

function QuickInventory({ product }: { product: Product }) {
  const [busy, setBusy] = useState(false);

  const run = async (action: string, value?: number) => {
    setBusy(true);
    await adjustInventory(product.id, action, value);
    setBusy(false);
  };

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <button
        disabled={busy || product.inventory <= 0}
        onClick={() => run("decrement")}
        className="flex h-6 w-6 items-center justify-center rounded bg-ld-border/50 text-sm font-bold text-ld-white hover:bg-ld-border disabled:opacity-30"
        aria-label="Decrease quantity"
      >
        −
      </button>
      <span className={`w-6 text-center font-semibold ${product.inventory <= 3 ? "text-ld-red" : "text-ld-white"}`}>
        {product.inventory}
      </span>
      <button
        disabled={busy}
        onClick={() => run("increment")}
        className="flex h-6 w-6 items-center justify-center rounded bg-ld-border/50 text-sm font-bold text-ld-white hover:bg-ld-border"
        aria-label="Increase quantity"
      >
        +
      </button>
      <button
        disabled={busy}
        onClick={() => run("restock", 10)}
        className="ml-1 rounded bg-ld-green/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ld-green opacity-0 transition-opacity group-hover:opacity-100 hover:bg-ld-green/25"
        title="Restock +10"
      >
        Restock
      </button>
      <button
        disabled={busy || product.inventory === 0}
        onClick={() => run("sold_out")}
        className="rounded bg-ld-red/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ld-red opacity-0 transition-opacity group-hover:opacity-100 hover:bg-ld-red/25"
        title="Mark sold out"
      >
        Sold Out
      </button>
    </div>
  );
}

export function InventoryTable({ products }: { products: Product[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("brand");
  const [showArchived, setShowArchived] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = showArchived ? products : products.filter((p) => p.status !== "archived");
    const rows = !q
      ? base
      : base.filter(
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
  }, [products, query, sortKey, showArchived]);

  const columns: { key: SortKey | null; label: string }[] = [
    { key: null, label: "" },
    { key: null, label: "Internal SKU" },
    { key: null, label: "UPC" },
    { key: "brand", label: "Brand" },
    { key: "name", label: "Product" },
    { key: null, label: "Size" },
    { key: "inventory", label: "Quantity" },
    { key: null, label: "Shelf" },
    { key: "retailPrice", label: "MSRP" },
    { key: "marketPrice", label: "Market" },
    { key: "lootPrice", label: "Live Price" },
    { key: null, label: "Status" },
    { key: null, label: "" },
  ];

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search SKU, UPC, brand, product, shelf, TikTok listing…"
          className="w-full max-w-md rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-2.5 text-sm text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple focus:ring-4 focus:ring-ld-purple/15"
        />
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm text-ld-muted">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          <p className="text-sm text-ld-muted">{filtered.length} products</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] border-separate border-spacing-y-2 text-sm">
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
                className="group cursor-pointer rounded-xl bg-ld-bg-elevated transition-colors hover:bg-ld-border/30"
              >
                <td className="rounded-l-xl px-3 py-2.5">
                  <BottleImage src={p.image} alt={p.name} color={p.color} glow={false} className="h-9 w-9" />
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-ld-cyan">{p.sku}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-ld-muted">{p.barcode}</td>
                <td className="px-3 py-2.5 font-medium text-ld-white">{p.brand}</td>
                <td className="px-3 py-2.5 text-ld-white">{p.name}</td>
                <td className="px-3 py-2.5 text-ld-muted">{p.size}</td>
                <td className="px-3 py-2.5">
                  <QuickInventory product={p} />
                </td>
                <td className="px-3 py-2.5 text-ld-muted">{p.shelf}</td>
                <td className="px-3 py-2.5 text-ld-muted">{formatCurrency(p.retailPrice)}</td>
                <td className="px-3 py-2.5 text-ld-white">{formatCurrency(p.marketPrice)}</td>
                <td className="px-3 py-2.5 font-semibold text-ld-purple">{formatCurrency(p.lootPrice)}</td>
                <td className="px-3 py-2.5">
                  <StatusBadge status={p.status} />
                </td>
                <td className="rounded-r-xl px-3 py-2.5">
                  <Link
                    href={`/inventory/${p.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs font-bold text-ld-purple hover:underline"
                  >
                    Edit
                  </Link>
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
