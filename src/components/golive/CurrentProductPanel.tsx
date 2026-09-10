"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Product } from "@/lib/types";
import type { CurrentProductFinancialsView } from "@/context/LiveSessionContext";
import { BottleImage } from "@/components/BottleImage";
import { AuthenticBadge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { formatCurrency } from "@/lib/format";
import { getFragranceNotes } from "@/lib/fragrance-notes";
import { useLiveSession } from "@/context/LiveSessionContext";
import { RecordSaleModal } from "./RecordSaleModal";

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className={`text-base font-semibold ${accent ?? "text-ld-white"}`}>{value}</p>
    </div>
  );
}

function FinancialStat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <p className={`text-[11px] font-bold uppercase tracking-widest ${accent}`}>{label}</p>
      <p className={`text-lg font-semibold ${accent}`}>{value}</p>
    </div>
  );
}

export function CurrentProductPanel({
  product,
  financials,
  hasQueue,
}: {
  product: Product | null;
  financials: CurrentProductFinancialsView | null;
  hasQueue: boolean;
}) {
  const { mode, nextItem, noSale, recordSale } = useLiveSession();
  const isTest = mode === "test";
  const [busy, setBusy] = useState<string | null>(null);
  const [showRecordSale, setShowRecordSale] = useState(false);

  if (!product) {
    return (
      <div className="glass-panel flex min-h-[420px] flex-col items-center justify-center rounded-2xl p-10 text-center">
        <p className="font-display text-2xl font-bold text-ld-muted">No product loaded</p>
        <p className="mt-2 max-w-sm text-sm text-ld-muted">
          Scan a barcode, or pick a product from search / the queue to start auctioning.
        </p>
      </div>
    );
  }

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    await fn();
    setBusy(null);
  };

  const notes = getFragranceNotes(product);
  const costLabel =
    financials?.costSource === "weighted_landed"
      ? "Cost (Wtd. Landed)"
      : financials?.costSource === "legacy"
        ? "Cost (Legacy)"
        : "Cost";

  return (
    <div className={`glass-panel relative overflow-hidden rounded-2xl ${isTest ? "ring-2 ring-ld-amber/60" : ""}`}>
      <div className={`absolute inset-x-0 top-0 h-1 ${isTest ? "bg-ld-amber" : "bg-ld-purple"}`} />

      <AnimatePresence mode="wait">
        <motion.div
          key={product.id}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="p-6 lg:p-8"
        >
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-ld-red/15 px-3 py-1 text-xs font-bold uppercase tracking-widest text-ld-red ring-1 ring-inset ring-ld-red/40">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ld-red" />
                Current Product
              </span>
              {isTest && (
                <span className="inline-flex items-center gap-1 rounded-full bg-ld-amber/15 px-3 py-1 text-xs font-bold uppercase tracking-widest text-ld-amber ring-1 ring-inset ring-ld-amber/40">
                  🧪 Simulated
                </span>
              )}
            </div>
            <AuthenticBadge authentic={product.authentic} />
          </div>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[240px_1fr]">
            <BottleImage src={product.image} alt={`${product.brand} ${product.name}`} color={product.color} className="h-56 lg:h-72" />

            <div className="space-y-5">
              <div>
                <p className="text-sm font-bold uppercase tracking-widest text-ld-cyan">{product.brand}</p>
                <h2 className="font-display text-3xl font-extrabold leading-tight text-ld-white lg:text-4xl">{product.name}</h2>
                <p className="mt-1 text-sm text-ld-muted">
                  {product.size} · {product.concentration || "—"} · SKU {product.sku}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label={isTest ? "Simulated Inventory" : "Inventory"}
                  value={`${product.inventory} units`}
                  accent={product.inventory <= 3 ? "text-ld-red" : undefined}
                />
                <Stat label="Shelf Location" value={product.shelf || "—"} />
                <Stat label="Projection" value={product.projection || "—"} />
                <Stat label="Longevity" value={product.longevity || "—"} />
              </div>

              <div className="rounded-xl border border-ld-border bg-ld-bg-elevated p-4">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-ld-muted">Fragrance Performance</p>
                <p className="text-sm text-ld-white">
                  <span className="font-semibold text-ld-cyan">Key Notes:</span> {notes.length > 0 ? notes.join(" • ") : "—"}
                </p>
              </div>

              <div className="rounded-xl border border-ld-amber/30 bg-ld-amber/5 p-4">
                <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-ld-amber">Operator Only — Not Shown on TV</p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <FinancialStat
                    label={costLabel}
                    value={financials?.cost != null ? formatCurrency(financials.cost) : "—"}
                    accent="text-ld-amber"
                  />
                  <FinancialStat
                    label="Break-Even"
                    value={financials?.breakEven.status === "ok" ? formatCurrency(financials.breakEven.breakEven) : "Not configured"}
                    accent="text-ld-amber"
                  />
                  <FinancialStat
                    label="Last Sold"
                    value={financials?.lastSoldPrice != null ? formatCurrency(financials.lastSoldPrice) : "—"}
                    accent="text-ld-white"
                  />
                  <FinancialStat
                    label="Avg Auction"
                    value={financials?.averageAuction != null ? formatCurrency(financials.averageAuction) : "No sales history"}
                    accent="text-ld-white"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-7 grid grid-cols-2 gap-3 border-t border-ld-border pt-6 lg:grid-cols-4">
            <Button
              variant="primary"
              size="xl"
              className="uppercase tracking-wide"
              disabled={busy !== null || !hasQueue}
              onClick={() => run("next", nextItem)}
            >
              {busy === "next" ? "Loading…" : "Next Item →"}
            </Button>
            <Button
              variant="cyan"
              size="xl"
              className="uppercase tracking-wide"
              disabled={busy !== null}
              onClick={() => setShowRecordSale(true)}
            >
              Record Sale
            </Button>
            <Button
              variant="outline"
              size="xl"
              className="uppercase tracking-wide"
              disabled={busy !== null}
              onClick={() => run("nosale", () => noSale(product.id))}
            >
              {busy === "nosale" ? "Recording…" : "No Sale"}
            </Button>
            <Button
              variant="ghost"
              size="xl"
              className="uppercase tracking-wide"
              onClick={() => window.alert(`Sending "${product.sku}" label to printer… (placeholder)`)}
            >
              🖨 Print Label
            </Button>
          </div>
        </motion.div>
      </AnimatePresence>

      {showRecordSale && (
        <RecordSaleModal
          product={product}
          onClose={() => setShowRecordSale(false)}
          onConfirm={async ({ quantity, winningBid }) => {
            await run("sale", () => recordSale({ productId: product.id, quantity, winningBid }));
            setShowRecordSale(false);
          }}
        />
      )}
    </div>
  );
}
