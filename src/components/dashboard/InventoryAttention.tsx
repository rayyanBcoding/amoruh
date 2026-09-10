"use client";

import Link from "next/link";
import { BottleImage } from "@/components/BottleImage";
import type { LowStockItem } from "@/lib/dashboard-db";

interface ProductRef {
  id: string;
  sku: string;
  brand: string;
  name: string;
  image: string;
  color: string;
}

type Row = LowStockItem & { product: ProductRef | null };

/** Low Stock alerts — each row a real, currently-low product, clicking
 *  through to its existing Inventory/product editor. Out of Stock has
 *  its own summary-card link (to /inventory?filter=sold_out); this list
 *  is specifically "running low," per the spec's example. */
export function InventoryAttention({ rows }: { rows: Row[] }) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Inventory Attention — Low Stock</h3>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ld-border p-6 text-center text-sm text-ld-muted">
          Nothing is running low right now.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Link
              key={row.productId}
              href={`/inventory/${row.productId}`}
              className="flex items-center gap-3 rounded-xl border border-ld-border bg-ld-bg-elevated p-2.5 hover:border-ld-amber/50"
            >
              {row.product ? (
                <BottleImage src={row.product.image} alt={row.product.name} color={row.product.color} glow={false} className="h-10 w-10 shrink-0" />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-lg bg-ld-border/30" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ld-white">
                  {row.product ? `${row.product.brand} ${row.product.name}` : "Unknown product"}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-ld-amber/15 px-2.5 py-0.5 text-xs font-bold text-ld-amber">
                {row.inventory} remaining
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
