"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { FocusedResolutionModal } from "@/components/pricing/FocusedResolutionModal";
import { SupplierPriceLeaders } from "@/components/pricing/SupplierPriceLeaders";
import { BuyingOpportunities } from "@/components/pricing/BuyingOpportunities";
import { SupplierFreshnessPanel } from "@/components/pricing/SupplierFreshnessPanel";
import { formatCurrency } from "@/lib/format";
import type { MatchReviewItem } from "@/lib/pricing-types";

interface SupplierBreakdown {
  supplierId: string;
  supplierName: string;
  currentlyListed: number;
  noLongerListed: number;
  matched: number;
  reviewRequired: number;
  unresolvedOffers: number;
  quietlyUnresolved: number;
  ignored: number;
}

interface FreshnessEntry {
  supplierId: string;
  supplierName: string;
  filename: string | null;
  completedAt: string | null;
  daysSinceLastCommit: number | null;
  status: "current" | "stale" | "never";
}

interface DashboardData {
  uploadsToday: number;
  /** Rolling count of Master Products auto-created across the recent
   *  uploads shown — an audit figure, never a call to action. */
  recentAutoCreated: number;
  freshness: FreshnessEntry[];
  matchReview: {
    reviewRequired: number;
    /** EVERY genuinely ambiguous offer, flagged or not — quiet,
     *  informational, never a required task count. reviewRequired is a
     *  subset of this, NOT a separate category. */
    unresolvedOffers: number;
    /** unresolvedOffers minus reviewRequired — the count actually
     *  displayed as "sitting quietly," since unresolvedOffers itself
     *  still includes the actively-flagged reviewRequired items. */
    quietlyUnresolved: number;
    matched: number;
    bySupplier: SupplierBreakdown[];
  };
  supplierCount: number;
}

// Three clearly labeled result types (plan §4) — never presented as if
// they were each other. A real, physically-carried Product; a Master
// Product AMORUH has never stocked; and a still-unresolved supplier
// offer that hasn't matched anything yet.
type SearchResult =
  | {
      type: "product";
      productId: string;
      brand: string;
      name: string;
      size: string;
      sku: string;
      score: number;
      carried: true;
      bestPriceUsd: number | null;
      eligibleSupplierCount: number;
    }
  | {
      type: "reference_product";
      referenceProductId: string;
      brand: string;
      name: string;
      sizeMl: number | null;
      concentration: string | null;
      carried: false;
      bestPriceUsd: number | null;
      eligibleSupplierCount: number;
    }
  | {
      type: "unresolved_offer";
      supplierId: string;
      supplierName: string;
      offerKey: string;
      description: string;
      brand: string;
      upc: string;
      supplierSku: string;
      price: number;
      currency: string;
      quantity: number | null;
      ageDays: number;
      reviewStatus: string;
      reviewRequestedAt: string | null;
    };

export default function PricingDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    fetch("/api/pricing/dashboard")
      .then((res) => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => {});
  }, []);

  // Debounced (250ms, same idiom as LinkTrackedItemSearch in
  // MatchReviewResolutionPanel.tsx) + a request-sequence-number guard so
  // a fast typist never has an older, slower response overwrite a newer
  // one — no shared debounce hook or AbortController exists anywhere in
  // this codebase, so this mirrors the established inline pattern rather
  // than introducing a new one.
  const searchSeq = useRef(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const handleQueryChange = (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      searchSeq.current++; // supersede any in-flight request
      setResults([]);
      setSearching(false);
    }
  };
  useEffect(() => {
    if (!query.trim()) return;
    const mySeq = ++searchSeq.current;
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/pricing/search?q=${encodeURIComponent(query)}`);
        const body = await res.json();
        if (mySeq !== searchSeq.current) return; // a newer keystroke already superseded this request
        setResults(body.results ?? []);
      } finally {
        if (mySeq === searchSeq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query, refreshNonce]);

  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const sendForReview = async (supplierId: string, offerKey: string) => {
    const key = `${supplierId}:${offerKey}`;
    setSendingKey(key);
    try {
      const res = await fetch("/api/pricing/match-review/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request_review", supplierId, offerKey }),
      });
      if (res.ok) {
        const now = new Date().toISOString();
        setResults((prev) =>
          prev.map((r) => (r.type === "unresolved_offer" && r.supplierId === supplierId && r.offerKey === offerKey ? { ...r, reviewRequestedAt: now } : r))
        );
      }
    } finally {
      setSendingKey(null);
    }
  };

  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [resolutionItem, setResolutionItem] = useState<MatchReviewItem | null>(null);
  const [resolveNotice, setResolveNotice] = useState<string | null>(null);
  // The shared entry point ANY workflow calls when it needs an exact
  // identity right now (requestIdentityResolution, pricing-product-
  // linking.ts) — "explicitly chooses to resolve/review it" from the
  // spec. Re-checks state first: if it's already resolved, nothing to
  // show; only genuine remaining ambiguity opens the focused modal.
  const resolveNow = async (supplierId: string, offerKey: string) => {
    const key = `${supplierId}:${offerKey}`;
    setResolvingKey(key);
    setResolveNotice(null);
    try {
      const res = await fetch("/api/pricing/match-review/request-resolution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId, offerKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResolveNotice(data?.error ?? "Could not check this item.");
        return;
      }
      if (data.status === "resolved") {
        setResolveNotice("Already resolved — no review needed.");
        return;
      }
      if (data.item) setResolutionItem(data.item);
    } finally {
      setResolvingKey(null);
    }
  };

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1400px] px-6 py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">Pricing / Ordering</h1>
          <div className="flex gap-2">
            <Link href="/pricing/match-review">
              <Button variant="cyan">Match Review{data && data.matchReview.reviewRequired > 0 ? ` (${data.matchReview.reviewRequired})` : ""}</Button>
            </Link>
            <Link href="/pricing/suppliers">
              <Button variant="primary">Suppliers</Button>
            </Link>
          </div>
        </div>

        <div className="glass-panel mb-6 rounded-2xl p-5">
          <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">
            Search a fragrance across every supplier
          </label>
          <input
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="e.g. aventis creed, sauvage elixir…"
            className="w-full rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-3 text-sm text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple focus:ring-4 focus:ring-ld-purple/15"
          />
          {searching && <p className="mt-2 text-xs text-ld-muted">Searching…</p>}
          {resolveNotice && <p className="mt-2 text-xs text-ld-cyan">{resolveNotice}</p>}
          {results.length > 0 && (
            <div className="mt-3 space-y-1">
              {results.map((r) => {
                if (r.type === "product") {
                  return (
                    <button
                      key={`product:${r.productId}`}
                      onClick={() => router.push(`/pricing/products/${r.productId}`)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm text-ld-white hover:bg-ld-bg-elevated"
                    >
                      <span>
                        {r.name.toUpperCase().startsWith(r.brand.trim().toUpperCase()) ? (
                          r.name
                        ) : (
                          <>
                            <span className="font-semibold">{r.brand}</span> {r.name}
                          </>
                        )}{" "}
                        <span className="text-ld-muted">({r.size})</span>
                      </span>
                      <SearchPricePreview bestPriceUsd={r.bestPriceUsd} eligibleSupplierCount={r.eligibleSupplierCount} carried />
                    </button>
                  );
                }
                if (r.type === "reference_product") {
                  return (
                    <button
                      key={`reference_product:${r.referenceProductId}`}
                      onClick={() => router.push(`/pricing/reference-products/${r.referenceProductId}`)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm text-ld-white hover:bg-ld-bg-elevated"
                    >
                      <span>
                        {r.name.toUpperCase().startsWith(r.brand.trim().toUpperCase()) ? (
                          r.name
                        ) : (
                          <>
                            <span className="font-semibold">{r.brand}</span> {r.name}
                          </>
                        )}
                        {r.sizeMl ? <span className="text-ld-muted"> ({r.sizeMl}ml{r.concentration ? ` ${r.concentration}` : ""})</span> : null}
                      </span>
                      <SearchPricePreview bestPriceUsd={r.bestPriceUsd} eligibleSupplierCount={r.eligibleSupplierCount} carried={false} />
                    </button>
                  );
                }
                const key = `${r.supplierId}:${r.offerKey}`;
                const ageDays = r.ageDays;
                return (
                  <div
                    key={`unresolved_offer:${key}`}
                    className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-ld-white hover:bg-ld-bg-elevated"
                  >
                    <button onClick={() => router.push(`/pricing/suppliers/${r.supplierId}`)} className="min-w-0 flex-1 text-left">
                      {r.description.toUpperCase().startsWith(r.brand.trim().toUpperCase()) && r.brand.trim() ? (
                        r.description
                      ) : (
                        <>
                          <span className="font-semibold">{r.brand}</span> {r.description}
                        </>
                      )}
                      <span className="text-ld-muted">
                        {" — "}
                        {r.supplierName} · {formatCurrency(r.price)} {r.currency !== "USD" && `(${r.currency})`}
                        {r.quantity !== null && ` · Qty ${r.quantity}`}
                        {(r.upc || r.supplierSku) && ` · ${r.upc || r.supplierSku}`}
                        {` · ${ageDays === 0 ? "today" : `${ageDays}d ago`}`}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="rounded-full bg-ld-amber/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-ld-amber">
                        Unresolved
                      </span>
                      {r.reviewStatus === "needs_review" &&
                        (r.reviewRequestedAt ? (
                          <span className="text-[10px] font-bold uppercase tracking-widest text-ld-cyan">Sent for Review ✓</span>
                        ) : (
                          <Button variant="outline" disabled={sendingKey === key} onClick={() => sendForReview(r.supplierId, r.offerKey)}>
                            Send for Review
                          </Button>
                        ))}
                      {(r.reviewStatus === "needs_review" || r.reviewStatus === "alias_conflict" || r.reviewStatus === "barcode_conflict") && (
                        <Button variant="cyan" disabled={resolvingKey === key} onClick={() => resolveNow(r.supplierId, r.offerKey)}>
                          Resolve Now
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Suppliers" value={data?.supplierCount ?? "—"} />
          <StatCard label="Lists Uploaded Today" value={data?.uploadsToday ?? "—"} />
          {/* Actionable human work ONLY — alias/barcode conflicts, plus
              anything explicitly sent for review. NOT every ambiguous
              item a supplier happens to list. */}
          <StatCard
            label="Review Required"
            value={data?.matchReview.reviewRequired ?? "—"}
            accent={data && data.matchReview.reviewRequired > 0 ? "text-ld-amber" : undefined}
          />
          {/* Audit-only — how many Master Products routine catalog growth
              created recently, never a queue or a call to action. */}
          <StatCard label="Master Products Auto-Created" value={data?.recentAutoCreated ?? "—"} accent="text-ld-purple" />
          <StatCard label="Matched" value={data?.matchReview.matched ?? "—"} accent="text-ld-green" />
        </div>

        {/* Deliberately NOT a StatCard — quiet, muted, informational
            only. This is the full universe of ambiguous supplier items
            (Review Required is the small actionable subset above); most
            of these will never be purchased and are not required work. */}
        <p className="mt-3 text-xs text-ld-muted">
          <span className="font-semibold text-ld-muted">{(data?.matchReview.quietlyUnresolved ?? 0).toLocaleString()}</span> more
          unresolved supplier offers sitting quietly in the background (on top of the {(data?.matchReview.reviewRequired ?? 0).toLocaleString()}{" "}
          above) — searchable, not a required task. Resolution is only needed if you try to order one.
        </p>

        <div className="mt-6">
          <SupplierPriceLeaders />
        </div>

        <div className="mt-6">
          <BuyingOpportunities />
        </div>

        {data && data.matchReview.bySupplier.length > 0 && (
          <div className="glass-panel mt-6 rounded-2xl p-5">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-ld-muted">Per-Supplier Match Review Breakdown</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-widest text-ld-muted">
                    <th className="py-1 pr-4">Supplier</th>
                    <th className="py-1 pr-4">Currently Listed</th>
                    <th className="py-1 pr-4">No Longer Listed</th>
                    <th className="py-1 pr-4">Matched</th>
                    <th className="py-1 pr-4">Review Required</th>
                    <th className="py-1 pr-4 font-normal normal-case tracking-normal text-ld-muted/70">Unresolved (quiet)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.matchReview.bySupplier.map((s) => (
                    <tr key={s.supplierId} className="border-t border-ld-border/40">
                      <td className="py-2 pr-4 font-semibold text-ld-white">{s.supplierName}</td>
                      <td className="py-2 pr-4 text-ld-white">{s.currentlyListed.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-ld-muted">{s.noLongerListed.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-ld-green">{s.matched.toLocaleString()}</td>
                      <td className={`py-2 pr-4 ${s.reviewRequired > 0 ? "font-semibold text-ld-amber" : "text-ld-muted"}`}>
                        {s.reviewRequired.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-ld-muted/70">{s.quietlyUnresolved.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="mt-6">
          <SupplierFreshnessPanel freshness={data?.freshness ?? []} />
        </div>
      </main>

      {resolutionItem && (
        <FocusedResolutionModal
          item={resolutionItem}
          onClose={() => setResolutionItem(null)}
          onResolved={() => {
            setResolutionItem(null);
            // Refresh so the "Sent for Review"/badge state in the search
            // results reflects whatever just happened.
            if (query.trim()) setRefreshNonce((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

/** Per-search-result price preview: lowest eligible current supplier
 *  price, count of eligible suppliers, an availability indicator, and
 *  carried/not-carried — computed server-side (search route) only for
 *  the small, already-ranked/limited final result set, never per
 *  scanned candidate. */
function SearchPricePreview({ bestPriceUsd, eligibleSupplierCount, carried }: { bestPriceUsd: number | null; eligibleSupplierCount: number; carried: boolean }) {
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
      {bestPriceUsd !== null ? (
        <span className="text-xs font-semibold text-ld-green">
          {formatCurrency(bestPriceUsd)} · {eligibleSupplierCount} supplier{eligibleSupplierCount === 1 ? "" : "s"}
        </span>
      ) : (
        <span className="text-xs text-ld-muted">No actionable offer</span>
      )}
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
          carried ? "bg-ld-green/15 text-ld-green" : "bg-ld-purple/15 text-ld-purple"
        }`}
      >
        {carried ? "Carried" : "Master Product — Not Carried"}
      </span>
    </span>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className={`mt-1 font-display text-3xl font-extrabold ${accent ?? "text-ld-white"}`}>{value}</p>
    </div>
  );
}
