"use client";

import { useState } from "react";
import type { Product } from "@/lib/types";
import type { CurrentProductFinancialsView } from "@/context/LiveSessionContext";
import { Button } from "@/components/Button";
import { useLiveSession } from "@/context/LiveSessionContext";
import { RecordSaleModal } from "./RecordSaleModal";
import { CompactCopilotCard } from "./CompactCopilotCard";
import { useCopilotHistory } from "./useCopilotHistory";

export function CurrentProductPanel({ product, financials, hasQueue }: {
  product: Product | null;
  financials: CurrentProductFinancialsView | null;
  hasQueue: boolean;
}) {
  const { mode, data, ledgerVersion, nextItem, noSale, recordSale } = useLiveSession();
  const isTest = mode === "test";
  const [busy, setBusy] = useState<string | null>(null);
  const [showRecordSale, setShowRecordSale] = useState(false);
  const history = useCopilotHistory(`${mode}:${data?.session?.id ?? "none"}:${ledgerVersion}`);

  if (!product) {
    return <div className="glass-panel flex min-h-[240px] flex-col items-center justify-center rounded-2xl p-10 text-center">
      <p className="font-display text-2xl font-bold text-ld-muted">No product loaded</p>
      <p className="mt-2 max-w-sm text-sm text-ld-muted">Scan a barcode, or pick a product from search / the queue to start auctioning.</p>
    </div>;
  }

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    await fn();
    setBusy(null);
  };

  return (
    <div className={`glass-panel relative overflow-hidden rounded-2xl p-5 lg:p-6 ${isTest ? "ring-2 ring-ld-amber/60" : ""}`}>
      <CompactCopilotCard
        key={product.id}
        product={product}
        financials={financials}
        history={{ state: history.state, row: history.rows.find((r) => r.productId === product.id) ?? null }}
        recent={data?.recent ?? []}
        isTest={isTest}
      />
      <div className="mt-4 grid grid-cols-1 gap-3 border-t border-ld-border pt-4 sm:grid-cols-3">
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
      </div>
      {showRecordSale && (
        <RecordSaleModal
          product={product}
          onClose={() => setShowRecordSale(false)}
          onConfirm={async ({ quantity, winningBid, allowOversell }) => {
            setBusy("sale");
            const result = await recordSale({ productId: product.id, quantity, winningBid, allowOversell });
            setBusy(null);
            // keep the modal open on a refusal so the host sees WHY and can choose "Sell anyway"
            if (result.ok) setShowRecordSale(false);
            return result;
          }}
        />
      )}
    </div>
  );
}
