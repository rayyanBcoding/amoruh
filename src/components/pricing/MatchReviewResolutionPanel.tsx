"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/Button";
import { ReviewStatusBadge } from "@/components/pricing/PricingBadges";
import { formatCurrency } from "@/lib/format";
import type { MatchReviewItem, PricingReferenceProduct } from "@/lib/pricing-types";
import type { Product } from "@/lib/types";

// ---------------------------------------------------------------------
// The Yes-Link / No-Not-a-Match / Search Another Product / Track for
// Pricing / Link tracked item / Ignore action set for ONE Match Review
// item — extracted from match-review/page.tsx so it can render either
// inline in the big list (as before) or standalone for a single offer
// (the focused resolution modal a workflow surfaces when it needs an
// exact identity right now — see requestIdentityResolution,
// pricing-product-linking.ts). Same actions, same behavior, one place.
// ---------------------------------------------------------------------

/** Inline "Link to tracked item…" search — separate from the real-
 *  catalog "Search Another Product…" select, since reference products
 *  can scale well beyond what a plain <select> of everything should
 *  ever hold. */
function LinkTrackedItemSearch({ onPick, disabled }: { onPick: (referenceProductId: string) => void; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PricingReferenceProduct[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const q = query.trim();
    const handle = setTimeout(
      () => {
        if (!q) {
          setResults([]);
          return;
        }
        fetch(`/api/pricing/reference-products?q=${encodeURIComponent(q)}&limit=8`)
          .then((res) => (res.ok ? res.json() : { items: [] }))
          .then((data) => setResults(data.items ?? []))
          .catch(() => setResults([]));
      },
      q ? 250 : 0
    );
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div className="relative">
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
        placeholder="Link to tracked item…"
        className="w-48 rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-xs text-ld-white outline-none focus:border-ld-cyan"
      />
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-64 rounded-lg border border-ld-border bg-ld-bg-card shadow-lg">
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                onPick(r.id);
                setQuery("");
                setResults([]);
                setOpen(false);
              }}
              className="block w-full truncate px-3 py-2 text-left text-xs text-ld-white hover:bg-ld-bg-elevated"
            >
              {r.brand} {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MatchReviewResolutionPanel({
  item,
  products,
  referenceProducts,
  busy,
  onResolve,
  onLinkTracked,
  onTrackForPricing,
  showActions = true,
}: {
  item: MatchReviewItem;
  products: Product[];
  referenceProducts: PricingReferenceProduct[];
  busy: boolean;
  onResolve: (body: Record<string, unknown>) => void;
  onLinkTracked: (referenceProductId: string) => void;
  onTrackForPricing: () => void;
  /** false renders just the header (description/price/tracked badge) —
   *  used for the read-only "Matched" tab, which has nothing to
   *  resolve. */
  showActions?: boolean;
}) {
  const candidateLabel = (productId: string | null) => {
    if (!productId) return null;
    const p = products.find((pr) => pr.id === productId);
    return p ? `${p.brand} ${p.name} (${p.size})` : null;
  };
  const referenceLabel = (referenceProductId: string | null) => {
    if (!referenceProductId) return null;
    const r = referenceProducts.find((rp) => rp.id === referenceProductId);
    return r ? `${r.brand} ${r.name}` : "Tracked item";
  };

  const label = candidateLabel(item.candidateProductId);
  const trackedLabel = referenceLabel(item.referenceProductId);
  // The RESOLVED identity this offer is matched to — a real Product
  // takes priority (comparison there already includes any linked Master
  // Product's own offers too); referenceProductId is the fallback for a
  // Master Product AMORUH has never physically stocked. Only ever
  // meaningful for an actually-matched offer (item.productId is the
  // CONFIRMED resolution, never a mere candidate/suggestion).
  const comparisonHref = item.productId
    ? `/pricing/products/${item.productId}`
    : item.referenceProductId
      ? `/pricing/reference-products/${item.referenceProductId}`
      : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold text-ld-white">{item.description || item.brand}</p>
          <p className="text-xs text-ld-muted">
            {item.supplierName} · {formatCurrency(item.price)} {item.currency !== "USD" && `(${item.currency})`}
            {item.quantity !== null && ` · Qty ${item.quantity}`}
            {item.upc && ` · UPC ${item.upc}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {trackedLabel && (
            <span className="inline-flex items-center gap-1 rounded-full bg-ld-cyan/15 px-2.5 py-1 text-xs font-semibold text-ld-cyan ring-1 ring-inset ring-ld-cyan/40">
              📎 Tracked as {trackedLabel}
            </span>
          )}
          <ReviewStatusBadge status={item.reviewStatus} confidence={item.matchConfidence} />
        </div>
      </div>

      {!showActions && comparisonHref && (
        <Link
          href={comparisonHref}
          className="mb-3 inline-flex items-center gap-1 rounded-lg bg-ld-purple/15 px-3 py-1.5 text-xs font-semibold text-ld-purple hover:bg-ld-purple/25"
        >
          View Product / Compare Suppliers →
        </Link>
      )}

      {showActions && label && (
        <p className="mb-3 text-sm text-ld-white">
          Is this the same product? <span className="font-semibold text-ld-cyan">{label}</span>
        </p>
      )}
      {showActions && (
      <div className="flex flex-wrap items-center gap-2">
        {item.candidateProductId && (
          <>
            <Button variant="cyan" size="md" disabled={busy} onClick={() => onResolve({ action: "link", productId: item.candidateProductId })}>
              Yes — Link
            </Button>
            <Button variant="danger" size="md" disabled={busy} onClick={() => onResolve({ action: "reject_candidate", productId: item.candidateProductId })}>
              No — Not a Match
            </Button>
          </>
        )}
        <select
          disabled={busy}
          value=""
          onChange={(e) => e.target.value && onResolve({ action: "link", productId: e.target.value })}
          className="rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-xs text-ld-white outline-none focus:border-ld-purple"
        >
          <option value="">Search Another Product…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} — {p.brand} {p.name} ({p.size})
            </option>
          ))}
        </select>
        {!trackedLabel && (
          <>
            <Button variant="outline" size="md" disabled={busy} onClick={onTrackForPricing}>
              📎 Track for Pricing
            </Button>
            <LinkTrackedItemSearch disabled={busy} onPick={onLinkTracked} />
          </>
        )}
        <Button variant="ghost" size="md" disabled={busy} onClick={() => onResolve({ action: "ignore" })}>
          Ignore
        </Button>
      </div>
      )}
    </div>
  );
}
