"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import type { LiveSnapshot } from "@/lib/types";
import { BottleImage } from "@/components/BottleImage";
import { NotesPyramid } from "@/components/NotesPyramid";
import { AuthenticBadge, StatusBadge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { formatCurrency } from "@/lib/format";
import { useLiveState } from "@/context/LiveStateContext";

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className={`text-base font-semibold ${accent ?? "text-ld-white"}`}>{value}</p>
    </div>
  );
}

export function CurrentProductCard({ snapshot }: { snapshot: LiveSnapshot }) {
  const { nextProduct, markSold, toggleFlashDeal } = useLiveState();
  const [busy, setBusy] = useState<string | null>(null);
  const product = snapshot.currentProduct;
  const flashDeal = snapshot.flashDeal;

  const runAction = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    await fn();
    setBusy(null);
  };

  if (!product) {
    return (
      <div className="glass-panel flex min-h-[420px] flex-col items-center justify-center rounded-2xl p-10 text-center">
        <p className="font-display text-2xl font-bold text-ld-muted">No product is live</p>
        <p className="mt-2 max-w-sm text-sm text-ld-muted">
          Scan a barcode below, or pick a product from search / the live queue to start the show.
        </p>
      </div>
    );
  }

  const livePrice = flashDeal.active
    ? Math.round(product.lootPrice * (1 - flashDeal.discountPercent / 100))
    : product.lootPrice;

  return (
    <div className="glass-panel relative overflow-hidden rounded-2xl">
      <div className="absolute inset-x-0 top-0 h-1 bg-ld-purple" />

      <AnimatePresence mode="wait">
        <motion.div
          key={product.id}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="p-6 lg:p-8"
        >
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-ld-red/15 px-3 py-1 text-xs font-bold uppercase tracking-widest text-ld-red ring-1 ring-inset ring-ld-red/40">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ld-red" />
                Live Now
              </span>
              <StatusBadge status={product.status} />
              {flashDeal.active && (
                <span className="inline-flex items-center gap-1 rounded-full bg-ld-amber/15 px-3 py-1 text-xs font-bold uppercase tracking-widest text-ld-amber ring-1 ring-inset ring-ld-amber/40">
                  ⚡ Flash Deal −{flashDeal.discountPercent}%
                </span>
              )}
            </div>
            <AuthenticBadge authentic={product.authentic} />
          </div>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[280px_1fr]">
            <BottleImage
              src={product.image}
              alt={`${product.brand} ${product.name}`}
              color={product.color}
              className="h-64 lg:h-80"
            />

            <div className="space-y-5">
              <div>
                <p className="text-sm font-bold uppercase tracking-widest text-ld-cyan">
                  {product.brand}
                </p>
                <h2 className="font-display text-3xl font-extrabold leading-tight text-ld-white lg:text-4xl">
                  {product.name}
                </h2>
                <p className="mt-1 text-sm text-ld-muted">
                  {product.size} · SKU {product.sku} · Shelf {product.shelf}
                </p>
              </div>

              <div className="flex flex-wrap items-end gap-6 rounded-xl border border-ld-border bg-ld-bg-elevated p-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">
                    Retail Price
                  </p>
                  <p className="text-lg font-semibold text-ld-muted line-through decoration-ld-red/70">
                    {formatCurrency(product.retailPrice)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">
                    Market Price
                  </p>
                  <p className="text-lg font-semibold text-ld-white">
                    {formatCurrency(product.marketPrice)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-ld-purple">
                    Live Price
                  </p>
                  <p className="font-display text-3xl font-extrabold text-gradient-brand">
                    {formatCurrency(livePrice)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Inventory" value={`${product.inventory} units`} accent={product.inventory <= 3 ? "text-ld-red" : undefined} />
                <Stat label="Shelf Location" value={product.shelf} />
                <Stat label="Projection" value={product.projection} />
                <Stat label="Longevity" value={product.longevity} />
              </div>

              <div className="border-t border-ld-border pt-4">
                <NotesPyramid
                  topNotes={product.topNotes}
                  middleNotes={product.middleNotes}
                  baseNotes={product.baseNotes}
                />
              </div>

              <div className="rounded-xl border border-ld-border bg-ld-bg-elevated p-4">
                <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">
                  TikTok Product Name
                </p>
                <p className="mt-1 text-sm font-medium text-ld-white">{product.tiktokListing}</p>
              </div>
            </div>
          </div>

          <div className="mt-7 grid grid-cols-2 gap-3 border-t border-ld-border pt-6 lg:grid-cols-4">
            <Button
              variant="primary"
              size="xl"
              className="uppercase tracking-wide"
              disabled={busy !== null}
              onClick={() => runAction("next", nextProduct)}
            >
              {busy === "next" ? "Loading…" : "Next Item →"}
            </Button>
            <Button
              variant="cyan"
              size="xl"
              className="uppercase tracking-wide"
              disabled={busy !== null || product.inventory <= 0}
              onClick={() => runAction("sold", markSold)}
            >
              {busy === "sold" ? "Marking…" : "✓ Sold"}
            </Button>
            <Button
              variant={flashDeal.active ? "danger" : "outline"}
              size="xl"
              className="uppercase tracking-wide"
              disabled={busy !== null}
              onClick={() => runAction("flash", () => toggleFlashDeal(20))}
            >
              {flashDeal.active ? "End Flash Deal" : "⚡ Flash Deal"}
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
    </div>
  );
}
