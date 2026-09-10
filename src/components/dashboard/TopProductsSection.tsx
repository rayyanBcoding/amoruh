"use client";

import Link from "next/link";
import { BottleImage } from "@/components/BottleImage";
import { formatCurrency } from "@/lib/format";
import type { ProductLivePerformance } from "@/lib/dashboard-db";

interface ProductRef {
  id: string;
  sku: string;
  brand: string;
  name: string;
  image: string;
  color: string;
}

type Row = ProductLivePerformance & { product: ProductRef | null };

function ProductCell({ product, fallbackId }: { product: ProductRef | null; fallbackId: string }) {
  if (!product) return <span className="text-ld-muted">Unknown product</span>;
  return (
    <Link href={`/inventory/${product.id}`} className="flex min-w-0 items-center gap-2.5 hover:text-ld-cyan" key={fallbackId}>
      <BottleImage src={product.image} alt={product.name} color={product.color} glow={false} className="h-9 w-9 shrink-0" />
      <span className="min-w-0 truncate text-sm font-semibold text-ld-white">
        {product.brand} {product.name}
      </span>
    </Link>
  );
}

function Table({
  title,
  rows,
  columns,
  emptyLabel,
}: {
  title: string;
  rows: Row[];
  columns: { label: string; render: (row: Row) => React.ReactNode; align?: "right" }[];
  emptyLabel: string;
}) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-widest text-ld-muted">{title}</h3>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ld-border p-6 text-center text-sm text-ld-muted">{emptyLabel}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-widest text-ld-muted">
                <th className="pb-2 pr-3">Product</th>
                {columns.map((c) => (
                  <th key={c.label} className={`pb-2 pr-3 ${c.align === "right" ? "text-right" : ""}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.productId} className="border-t border-ld-border/40">
                  <td className="py-2.5 pr-3">
                    <ProductCell product={row.product} fallbackId={row.productId} />
                  </td>
                  {columns.map((c) => (
                    <td key={c.label} className={`py-2.5 pr-3 ${c.align === "right" ? "text-right" : ""}`}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function TopSellersTable({ rows }: { rows: Row[] }) {
  return (
    <Table
      title="Top Sellers"
      rows={rows}
      emptyLabel="No sales in this window yet."
      columns={[
        { label: "Units Sold", render: (r) => r.unitsSold },
        { label: "Revenue", render: (r) => <span className="font-semibold text-ld-green">{formatCurrency(r.revenue)}</span> },
        { label: "Avg Auction", render: (r) => (r.averageAuction != null ? formatCurrency(r.averageAuction) : "—") },
        { label: "Gross Profit", render: (r) => (r.grossProfit != null ? formatCurrency(r.grossProfit) : "—") },
      ]}
    />
  );
}

export function HighestSellThroughTable({ rows }: { rows: Row[] }) {
  return (
    <Table
      title="Highest Sell-Through"
      rows={rows}
      emptyLabel="Not enough presentations yet (minimum 5 needed to rank)."
      columns={[
        { label: "Times Presented", render: (r) => r.timesPresented },
        { label: "Times Sold", render: (r) => r.timesSold },
        {
          label: "Sell-Through",
          render: (r) => <span className="font-semibold text-ld-cyan">{r.sellThrough != null ? `${Math.round(r.sellThrough * 100)}%` : "—"}</span>,
        },
      ]}
    />
  );
}

export function MostProfitableTable({ rows }: { rows: Row[] }) {
  return (
    <Table
      title="Most Profitable"
      rows={rows}
      emptyLabel="No profit data in this window yet."
      columns={[
        { label: "Units Sold", render: (r) => r.unitsSold },
        { label: "Gross Profit", render: (r) => <span className="font-semibold text-ld-green">{r.grossProfit != null ? formatCurrency(r.grossProfit) : "—"}</span> },
        { label: "Avg Profit / Unit", render: (r) => (r.averageProfitPerUnit != null ? formatCurrency(r.averageProfitPerUnit) : "—") },
      ]}
    />
  );
}

export function ProductsToWatchTable({ rows }: { rows: Row[] }) {
  return (
    <Table
      title="Products to Watch"
      rows={rows}
      emptyLabel="Nothing is underperforming enough to flag right now."
      columns={[
        { label: "Presented", render: (r) => r.timesPresented },
        { label: "Sold", render: (r) => r.timesSold },
        {
          label: "Sell-Through",
          render: (r) => <span className="font-semibold text-ld-amber">{r.sellThrough != null ? `${Math.round(r.sellThrough * 100)}%` : "—"}</span>,
        },
      ]}
    />
  );
}
