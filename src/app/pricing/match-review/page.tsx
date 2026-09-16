"use client";

import { useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { TrackForPricingModal } from "@/components/pricing/TrackForPricingModal";
import { MatchReviewResolutionPanel } from "@/components/pricing/MatchReviewResolutionPanel";
import type { MatchReviewBucket, MatchReviewItem, MatchReviewSummary, PricingReferenceProduct } from "@/lib/pricing-types";
import type { Product } from "@/lib/types";

const PAGE_SIZE = 50;

// No "New Product Candidates" tab — "no existing match" resolves into
// one of these two at processing time (see pricing-process.ts). A
// structurally-complete row auto-creates and lands in Matched
// immediately; anything genuinely ambiguous or incomplete only lands
// here once it's actually flagged for review (an alias/barcode
// conflict, or an explicit "Send for Review") — see pricing-db.ts's
// isActiveReviewRequired. Most ambiguous supplier-catalog items never
// show up here at all; they sit quietly, searchable, until they matter.
const TABS: { key: MatchReviewBucket; label: string }[] = [
  { key: "review_required", label: "Review Required" },
  { key: "matched", label: "Matched" },
];

export default function MatchReviewPage() {
  const [bucket, setBucket] = useState<MatchReviewBucket>("review_required");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<MatchReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [summary, setSummary] = useState<MatchReviewSummary | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [referenceProducts, setReferenceProducts] = useState<PricingReferenceProduct[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [trackModalFor, setTrackModalFor] = useState<MatchReviewItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const itemKey = (i: MatchReviewItem) => `${i.supplierId}::${i.offerKey}`;

  const loadPage = (offset: number, append: boolean) => {
    // Deferred a tick — react-hooks/set-state-in-effect flags any
    // setState reachable SYNCHRONOUSLY from an effect body (this
    // function is called directly from the tab-switch effect below);
    // queuing it as a microtask keeps the loading indicator working
    // without that lint violation.
    Promise.resolve().then(() => setLoading(true));
    const params = new URLSearchParams({ bucket, offset: String(offset), limit: String(PAGE_SIZE) });
    if (search.trim()) params.set("search", search.trim());
    fetch(`/api/pricing/match-review?${params}`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data) return;
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setTotal(data.total);
        setNextOffset(data.nextOffset);
        setSummary(data.summary);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadPage(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket]);

  useEffect(() => {
    fetch("/api/products")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setProducts(Array.isArray(data) ? data : []))
      .catch(() => {});
    // A plain, unpaginated fetch is fine at today's reference-product
    // scale (client-side label resolution, same pattern already used
    // for `products` above) — once this collection grows well past a
    // few hundred, swap this for a batch "resolve these specific ids"
    // endpoint instead of loading more of it up front. The storage
    // layer itself (pricing-db.ts) is already built for that scale;
    // this is purely a UI shortcut.
    fetch("/api/pricing/reference-products?limit=500")
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data) => setReferenceProducts(Array.isArray(data.items) ? data.items : []))
      .catch(() => {});
  }, []);

  const runSearch = () => loadPage(0, false);

  const resolve = async (item: MatchReviewItem, body: Record<string, unknown>) => {
    setBusyKey(itemKey(item));
    setError(null);
    try {
      const res = await fetch("/api/pricing/match-review/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: item.supplierId, offerKey: item.offerKey, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not resolve this item.");
      setItems((prev) => prev.filter((i) => itemKey(i) !== itemKey(item)));
      setTotal((t) => Math.max(0, t - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyKey(null);
    }
  };

  const linkTrackedItem = async (item: MatchReviewItem, referenceProductId: string) => {
    setBusyKey(itemKey(item));
    setError(null);
    try {
      const res = await fetch(`/api/pricing/suppliers/${item.supplierId}/offers/${encodeURIComponent(item.offerKey)}/link-reference-product`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceProductId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not link this item.");
      loadPage(0, false); // moves the item to the Tracked sub-view / updates counts
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1300px] px-6 py-6">
        <h1 className="mb-1 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">Match Review</h1>

        {summary && summary.bySupplier.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-3 text-xs text-ld-muted">
            {summary.bySupplier.map((s) => (
              <span key={s.supplierId} className="rounded-lg bg-ld-bg-elevated px-3 py-1.5">
                <span className="font-semibold text-ld-white">{s.supplierName}</span> — Listed {s.currentlyListed.toLocaleString()}
                {s.noLongerListed > 0 && <span className="text-ld-muted"> · {s.noLongerListed.toLocaleString()} no longer listed</span>}
                {" · "}
                <span className="text-ld-green">{s.matched} matched</span>
                {" · "}
                <span className={s.reviewRequired > 0 ? "font-semibold text-ld-amber" : ""}>{s.reviewRequired} review</span>
              </span>
            ))}
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {TABS.map((t) => {
            const count = summary ? (t.key === "review_required" ? summary.reviewRequired : summary.matched) : null;
            return (
              <button
                key={t.key}
                onClick={() => setBucket(t.key)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${bucket === t.key ? "bg-ld-purple text-ld-white" : "bg-ld-bg-elevated text-ld-muted hover:text-ld-white"}`}
              >
                {t.label}
                {count !== null && ` (${count.toLocaleString()})`}
              </button>
            );
          })}
        </div>

        <div className="mb-4 flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            placeholder="Search description, brand, or supplier SKU…"
            className="flex-1 rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-2.5 text-sm text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple"
          />
          <Button variant="outline" onClick={runSearch} disabled={loading}>
            Search
          </Button>
        </div>

        {error && <div className="glass-panel mb-6 rounded-xl border border-ld-red/30 p-4 text-sm text-ld-red">{error}</div>}

        <p className="mb-3 text-xs text-ld-muted">
          Showing {items.length.toLocaleString()} of {total.toLocaleString()}
        </p>

        {items.length === 0 && !loading ? (
          <div className="glass-panel rounded-2xl p-10 text-center text-ld-muted">Nothing here right now.</div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => {
              const key = itemKey(item);
              const busy = busyKey === key;
              return (
                <div key={key} className="glass-panel rounded-2xl p-5">
                  <MatchReviewResolutionPanel
                    item={item}
                    products={products}
                    referenceProducts={referenceProducts}
                    busy={busy}
                    onResolve={(body) => resolve(item, body)}
                    onLinkTracked={(refId) => linkTrackedItem(item, refId)}
                    onTrackForPricing={() => setTrackModalFor(item)}
                    showActions={bucket === "review_required"}
                  />
                </div>
              );
            })}
          </div>
        )}

        {nextOffset !== null && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" disabled={loading} onClick={() => loadPage(nextOffset, true)}>
              {loading ? "Loading…" : `Load More (${(total - items.length).toLocaleString()} remaining)`}
            </Button>
          </div>
        )}
      </main>

      {trackModalFor && (
        <TrackForPricingModal
          item={trackModalFor}
          onClose={() => setTrackModalFor(null)}
          onSaved={() => {
            setTrackModalFor(null);
            loadPage(0, false);
            // Pick up the newly-created reference product for label
            // resolution without waiting for the next full page load.
            fetch("/api/pricing/reference-products?limit=500")
              .then((res) => (res.ok ? res.json() : { items: [] }))
              .then((data) => setReferenceProducts(Array.isArray(data.items) ? data.items : []))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}
