"use client";

import Link from "next/link";
import { BottleImage } from "@/components/BottleImage";
import type { ReorderCandidate } from "@/lib/dashboard-db";

interface ProductRef {
  id: string;
  sku: string;
  brand: string;
  name: string;
  image: string;
  color: string;
}

type Row = ReorderCandidate & { product: ProductRef | null };

/** Purely informational — never auto-creates a Draft Purchase or Order.
 *  Flagged only when inventory is below what a typical Live actually
 *  sells through AND the product has proven it sells well (sell-through
 *  ≥60%) — a slow mover running low is not a reorder candidate, just a
 *  slow mover. Clicking routes to the real Pricing/Ordering page for
 *  that product. */
export function ReorderIntelligence({ rows }: { rows: Row[] }) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Reorder Intelligence</h3>
      <p className="mb-3 text-xs text-ld-muted">
        Informational only — nothing here creates a purchase order. Click through to Pricing / Ordering to act on it.
      </p>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ld-border p-6 text-center text-sm text-ld-muted">
          No reorder signals right now.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Link
              key={row.productId}
              href={`/pricing/products/${row.productId}`}
              className="flex items-center gap-3 rounded-xl border border-ld-border bg-ld-bg-elevated p-2.5 hover:border-ld-cyan/50"
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
                <p className="text-xs text-ld-muted">
                  {row.currentInventory} in stock · avg {row.averageUnitsPerLivePresented.toFixed(1)}/Live ·{" "}
                  {Math.round(row.sellThrough * 100)}% sell-through
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-ld-cyan/15 px-2.5 py-0.5 text-xs font-bold uppercase text-ld-cyan">
                Potential Reorder
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
