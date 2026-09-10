"use client";

import { useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { ReviewStatusBadge } from "@/components/pricing/PricingBadges";
import { TrackForPricingModal } from "@/components/pricing/TrackForPricingModal";
import { formatCurrency } from "@/lib/format";
import type { MatchReviewBucket, MatchReviewItem, MatchReviewSummary, PricingReferenceProduct } from "@/lib/pricing-types";
import type { Product } from "@/lib/types";

const PAGE_SIZE = 50;

const TABS: { key: MatchReviewBucket; label: string }[] = [
  { key: "review_required", label: "Review Required" },
  { key: "new_candidates", label: "New Product Candidates" },
  { key: "matched", label: "Matched" },
];

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
    // Deferred a tick — react-hooks/set-state-in-effect flags any
    // setState reachable synchronously from an effect body, including
    // the immediate "clear results" path below.
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

export default function MatchReviewPage() {
  const [bucket, setBucket] = useState<MatchReviewBucket>("review_required");
  const [tracked, setTracked] = useState(false); // sub-view within new_candidates
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
    if (bucket === "new_candidates") params.set("tracked", String(tracked));
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
  }, [bucket, tracked]);

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
                {" · "}
                <span className="text-ld-cyan">{s.newCandidatesUntracked.toLocaleString()} new</span>
                {s.newCandidatesTracked > 0 && <span className="text-ld-muted"> ({s.newCandidatesTracked.toLocaleString()} tracked)</span>}
              </span>
            ))}
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {TABS.map((t) => {
            const count = summary
              ? t.key === "review_required"
                ? summary.reviewRequired
                : t.key === "new_candidates"
                  ? summary.newCandidatesUntracked
                  : summary.matched
              : null;
            return (
              <button
                key={t.key}
                onClick={() => {
                  setBucket(t.key);
                  setTracked(false);
                }}
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${bucket === t.key ? "bg-ld-purple text-ld-white" : "bg-ld-bg-elevated text-ld-muted hover:text-ld-white"}`}
              >
                {t.label}
                {count !== null && ` (${count.toLocaleString()})`}
              </button>
            );
          })}
        </div>

        {bucket === "new_candidates" && (
          <>
            <div className="mb-4 flex gap-1">
              <button
                onClick={() => setTracked(false)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-wide ${!tracked ? "bg-ld-cyan/20 text-ld-cyan" : "text-ld-muted hover:text-ld-white"}`}
              >
                Untracked{summary && ` (${summary.newCandidatesUntracked.toLocaleString()})`}
              </button>
              <button
                onClick={() => setTracked(true)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-wide ${tracked ? "bg-ld-cyan/20 text-ld-cyan" : "text-ld-muted hover:text-ld-white"}`}
              >
                📎 Tracked for Pricing{summary && ` (${summary.newCandidatesTracked.toLocaleString()})`}
              </button>
            </div>
            <p className="mb-4 text-sm text-ld-muted">
              These supplier listings simply don&apos;t match anything in your catalog yet — not urgent, nothing to decide. Track
              one for pricing to name it and compare it across suppliers, without ever adding it to Inventory.
            </p>
          </>
        )}

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
              const label = candidateLabel(item.candidateProductId);
              const trackedLabel = referenceLabel(item.referenceProductId);
              return (
                <div key={key} className="glass-panel rounded-2xl p-5">
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

                  {bucket === "review_required" && (
                    <>
                      {label && (
                        <p className="mb-3 text-sm text-ld-white">
                          Is this the same product? <span className="font-semibold text-ld-cyan">{label}</span>
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {item.candidateProductId && (
                          <Button variant="cyan" size="md" disabled={busy} onClick={() => resolve(item, { action: "link", productId: item.candidateProductId })}>
                            Yes — Link
                          </Button>
                        )}
                        <select
                          disabled={busy}
                          value=""
                          onChange={(e) => e.target.value && resolve(item, { action: "link", productId: e.target.value })}
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
                            <Button variant="outline" size="md" disabled={busy} onClick={() => setTrackModalFor(item)}>
                              📎 Track for Pricing
                            </Button>
                            <LinkTrackedItemSearch disabled={busy} onPick={(refId) => linkTrackedItem(item, refId)} />
                          </>
                        )}
                        <Button variant="ghost" size="md" disabled={busy} onClick={() => resolve(item, { action: "ignore" })}>
                          Ignore
                        </Button>
                      </div>
                    </>
                  )}

                  {bucket === "new_candidates" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        disabled={busy}
                        value=""
                        onChange={(e) => e.target.value && resolve(item, { action: "link", productId: e.target.value })}
                        className="rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-xs text-ld-white outline-none focus:border-ld-purple"
                      >
                        <option value="">Link to Existing Inventory Product…</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.sku} — {p.brand} {p.name} ({p.size})
                          </option>
                        ))}
                      </select>
                      {!trackedLabel && (
                        <>
                          <Button variant="outline" size="md" disabled={busy} onClick={() => setTrackModalFor(item)}>
                            📎 Track for Pricing
                          </Button>
                          <LinkTrackedItemSearch disabled={busy} onPick={(refId) => linkTrackedItem(item, refId)} />
                        </>
                      )}
                    </div>
                  )}
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
