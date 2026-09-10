"use client";

import { useEffect, useState } from "react";
import { TVStage } from "@/components/tv/TVStage";
import type { TVProduct } from "@/lib/live-types";
import type { FlashDeal } from "@/lib/types";

// Local default — deliberately not imported from src/lib/db.ts, which
// pulls in the server-only Redis client; this is a client component.
function defaultFlashDeal(): FlashDeal {
  return { active: false, discountPercent: 20, startedAt: null };
}

// Pure customer-facing display, meant to run full-screen on a TV behind
// the auctioneer. No nav, no operator controls, no inventory/shelf/cost
// data — and, unlike before, this page never even RECEIVES that data: it
// polls the dedicated /api/tv/current endpoint, which returns only the
// explicit customer-safe allowlist (see src/lib/tv.ts). It deliberately
// does not use the shared LiveStateContext/SSE snapshot — that snapshot
// carries the full Product object (cost, shelf, notes) for every other
// authenticated screen, and putting that on the wire to a TV tab was
// exactly the payload gap the Go Live plan fixed.
const POLL_INTERVAL_MS = 2500;

export default function TVDisplayPage() {
  const [product, setProduct] = useState<TVProduct | null>(null);
  const [flashDeal, setFlashDeal] = useState<FlashDeal>(defaultFlashDeal());
  const [isTest, setIsTest] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/tv/current", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        setProduct(data.product ?? null);
        if (data.flashDeal) setFlashDeal(data.flashDeal);
        setIsTest(Boolean(data.isTest));
        setLoading(false);
      } catch {
        // A single failed poll isn't worth flashing an error on a TV —
        // the next tick tries again.
      }
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-ld-bg">
        <p className="animate-pulse font-display text-3xl font-bold text-ld-muted">
          AMORUH Live OS
        </p>
      </div>
    );
  }

  return <TVStage product={product} flashDeal={flashDeal} isTest={isTest} />;
}
