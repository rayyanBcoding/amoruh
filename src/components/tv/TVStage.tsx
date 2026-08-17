"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { LiveSnapshot } from "@/lib/types";
import { Logo } from "@/components/Logo";
import { formatCurrency } from "@/lib/format";

export function TVStage({ snapshot }: { snapshot: LiveSnapshot }) {
  const product = snapshot.currentProduct;
  const flashDeal = snapshot.flashDeal;

  const livePrice = product
    ? flashDeal.active
      ? Math.round(product.lootPrice * (1 - flashDeal.discountPercent / 100))
      : product.lootPrice
    : 0;
  const savings = product ? Math.max(0, product.retailPrice - livePrice) : 0;

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-ld-bg">
      <header className="relative z-10 flex items-center justify-between px-14 pt-10">
        <Logo size="lg" href={null} />
        <AnimatePresence>
          {flashDeal.active && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.2 }}
              className="animate-pulse-glow rounded-full bg-ld-amber px-8 py-3 font-display text-2xl font-extrabold text-ld-bg"
            >
              ⚡ FLASH DEAL −{flashDeal.discountPercent}%
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-14">
        <AnimatePresence mode="wait">
          {product ? (
            <motion.div
              key={product.id}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="grid w-full max-w-[1500px] grid-cols-1 items-center gap-16 lg:grid-cols-[1fr_1.1fr]"
            >
              <div className="flex items-center justify-center">
                <div className="relative flex h-[520px] w-full items-center justify-center">
                  <div
                    className="absolute h-[420px] w-[420px] rounded-full blur-[110px] opacity-[0.16]"
                    style={{ background: product.color }}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={product.image}
                    alt={`${product.brand} ${product.name}`}
                    className="relative h-full w-auto drop-shadow-[0_25px_40px_rgba(47,46,34,0.22)]"
                  />
                </div>
              </div>

              <div className="space-y-8">
                <div>
                  <p className="font-display text-2xl font-bold uppercase tracking-[0.3em] text-ld-cyan">
                    {product.brand}
                  </p>
                  <h1 className="font-display text-6xl font-extrabold leading-[1.05] text-ld-white lg:text-7xl">
                    {product.name}
                  </h1>
                  <p className="mt-3 text-2xl font-medium text-ld-muted">{product.size}</p>
                </div>

                <div className="flex flex-wrap items-end gap-10 rounded-3xl border border-ld-border bg-ld-bg-card p-8">
                  <div>
                    <p className="text-sm font-bold uppercase tracking-widest text-ld-muted">
                      Retail
                    </p>
                    <p className="text-3xl font-semibold text-ld-muted line-through decoration-ld-red/70">
                      {formatCurrency(product.retailPrice)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-bold uppercase tracking-widest text-ld-muted">
                      Market
                    </p>
                    <p className="text-3xl font-semibold text-ld-white">
                      {formatCurrency(product.marketPrice)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-bold uppercase tracking-widest text-ld-purple">
                      AMORUH Live Price
                    </p>
                    <p className="font-display text-7xl font-extrabold text-gradient-brand">
                      {formatCurrency(livePrice)}
                    </p>
                  </div>
                  {savings > 0 && (
                    <span className="rounded-full bg-ld-green/15 px-4 py-2 text-lg font-bold text-ld-green">
                      Save {formatCurrency(savings)}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-6">
                  <div className="rounded-2xl border border-ld-border bg-ld-bg-card p-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-ld-cyan">
                      Top Notes
                    </p>
                    <p className="mt-1 text-lg font-semibold text-ld-white">
                      {product.topNotes.join(", ")}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-ld-border bg-ld-bg-card p-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-ld-purple">
                      Projection
                    </p>
                    <p className="mt-1 text-lg font-semibold text-ld-white">{product.projection}</p>
                  </div>
                  <div className="rounded-2xl border border-ld-border bg-ld-bg-card p-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-ld-amber">
                      Longevity
                    </p>
                    <p className="mt-1 text-lg font-semibold text-ld-white">{product.longevity}</p>
                  </div>
                </div>

                {product.authentic && (
                  <span className="inline-flex items-center gap-2 rounded-full bg-ld-cyan/10 px-5 py-2.5 text-base font-bold text-ld-cyan ring-1 ring-inset ring-ld-cyan/25">
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                      <path
                        fillRule="evenodd"
                        d="M10 1.5l7 3.11v5.64c0 4.83-3 8.9-7 10.25-4-1.35-7-5.42-7-10.25V4.61l7-3.11zm-1.03 12.03l5.03-5.03-1.06-1.06-3.97 3.97-1.97-1.97-1.06 1.06 3.03 3.03z"
                        clipRule="evenodd"
                      />
                    </svg>
                    100% Authentic
                  </span>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="text-center"
            >
              <p className="font-display text-5xl font-extrabold text-ld-muted">
                Stay tuned — next drop coming up
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="relative z-10 px-14 pb-8 text-center text-sm font-medium uppercase tracking-[0.4em] text-ld-muted">
        AMORUH · Live On TikTok
      </footer>
    </div>
  );
}
