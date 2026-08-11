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

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-ld-bg">
      {/* ambient brand glow */}
      <div className="pointer-events-none absolute -left-40 -top-40 h-[560px] w-[560px] rounded-full bg-ld-purple/25 blur-[160px]" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-[560px] w-[560px] rounded-full bg-ld-cyan/20 blur-[160px]" />

      <header className="relative z-10 flex items-center justify-between px-14 pt-10">
        <Logo size="lg" href={null} />
        <AnimatePresence>
          {flashDeal.active && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="animate-pulse-glow rounded-full bg-gradient-to-r from-ld-amber to-ld-red px-8 py-3 font-display text-2xl font-extrabold text-ld-bg"
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
              initial={{ opacity: 0, x: 80, scale: 0.97 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -80, scale: 0.97 }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              className="grid w-full max-w-[1500px] grid-cols-1 items-center gap-16 lg:grid-cols-[1fr_1.1fr]"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.85, rotate: -3 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
                className="flex items-center justify-center"
              >
                <div className="relative flex h-[520px] w-full items-center justify-center">
                  <div
                    className="absolute h-[420px] w-[420px] rounded-full blur-[110px] opacity-50"
                    style={{ background: product.color }}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={product.image}
                    alt={`${product.brand} ${product.name}`}
                    className="relative h-full w-auto drop-shadow-[0_35px_60px_rgba(0,0,0,0.6)]"
                  />
                </div>
              </motion.div>

              <div className="space-y-8">
                <div>
                  <motion.p
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.12 }}
                    className="font-display text-2xl font-bold uppercase tracking-[0.3em] text-ld-cyan"
                  >
                    {product.brand}
                  </motion.p>
                  <motion.h1
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.18 }}
                    className="font-display text-6xl font-extrabold leading-[1.05] text-white lg:text-7xl"
                  >
                    {product.name}
                  </motion.h1>
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.24 }}
                    className="mt-3 text-2xl font-medium text-ld-muted"
                  >
                    {product.size}
                  </motion.p>
                </div>

                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.28 }}
                  className="flex flex-wrap items-end gap-10 rounded-3xl border border-ld-border bg-white/[0.03] p-8"
                >
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
                    <p className="text-3xl font-semibold text-white">
                      {formatCurrency(product.marketPrice)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-bold uppercase tracking-widest text-ld-cyan">
                      Loot Depot Price
                    </p>
                    <p className="font-display text-6xl font-extrabold text-gradient-brand">
                      {formatCurrency(livePrice)}
                    </p>
                  </div>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.34 }}
                  className="grid grid-cols-3 gap-6"
                >
                  <div className="rounded-2xl border border-ld-border bg-white/[0.03] p-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-ld-cyan">
                      Top Notes
                    </p>
                    <p className="mt-1 text-lg font-semibold text-white">
                      {product.topNotes.join(", ")}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-ld-border bg-white/[0.03] p-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-ld-purple">
                      Projection
                    </p>
                    <p className="mt-1 text-lg font-semibold text-white">{product.projection}</p>
                  </div>
                  <div className="rounded-2xl border border-ld-border bg-white/[0.03] p-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-ld-amber">
                      Longevity
                    </p>
                    <p className="mt-1 text-lg font-semibold text-white">{product.longevity}</p>
                  </div>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.4 }}
                  className="flex items-center gap-3"
                >
                  {product.authentic && (
                    <span className="inline-flex items-center gap-2 rounded-full bg-ld-cyan/15 px-5 py-2.5 text-base font-bold text-ld-cyan ring-1 ring-inset ring-ld-cyan/40">
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
                </motion.div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
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
        Loot Depot · Live On TikTok
      </footer>
    </div>
  );
}
