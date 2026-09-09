"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";

interface SupplierBreakdown {
  supplierId: string;
  supplierName: string;
  currentlyListed: number;
  noLongerListed: number;
  matched: number;
  reviewRequired: number;
  newCandidates: number;
  ignored: number;
}

interface DashboardData {
  uploadsToday: number;
  recentUploads: {
    id: string;
    supplierId: string;
    filename: string;
    status: string;
    uploadType: string;
    totalRows: number;
    autoMatched: number;
    needsReview: number;
    newCandidates: number;
    startedAt: string;
    isLive: boolean;
  }[];
  matchReview: { reviewRequired: number; newCandidates: number; matched: number; bySupplier: SupplierBreakdown[] };
  supplierCount: number;
}

export default function PricingDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<{ productId: string; brand: string; name: string; size: string }[]>([]);

  useEffect(() => {
    fetch("/api/pricing/dashboard")
      .then((res) => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => {});
  }, []);

  const runSearch = async (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/pricing/search?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      setResults(body.results ?? []);
    } finally {
      setSearching(false);
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
            onChange={(e) => runSearch(e.target.value)}
            placeholder="e.g. aventis creed, sauvage elixir…"
            className="w-full rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-3 text-sm text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple focus:ring-4 focus:ring-ld-purple/15"
          />
          {searching && <p className="mt-2 text-xs text-ld-muted">Searching…</p>}
          {results.length > 0 && (
            <div className="mt-3 space-y-1">
              {results.map((r) => (
                <button
                  key={r.productId}
                  onClick={() => router.push(`/pricing/products/${r.productId}`)}
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm text-ld-white hover:bg-ld-bg-elevated"
                >
                  <span className="font-semibold">{r.brand}</span> {r.name} <span className="text-ld-muted">({r.size})</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Suppliers" value={data?.supplierCount ?? "—"} />
          <StatCard label="Lists Uploaded Today" value={data?.uploadsToday ?? "—"} />
          <StatCard
            label="Review Required"
            value={data?.matchReview.reviewRequired ?? "—"}
            accent={data && data.matchReview.reviewRequired > 0 ? "text-ld-amber" : undefined}
          />
          <StatCard label="New Product Candidates" value={data?.matchReview.newCandidates ?? "—"} accent="text-ld-cyan" />
          <StatCard label="Matched" value={data?.matchReview.matched ?? "—"} accent="text-ld-green" />
        </div>

        {data && data.matchReview.bySupplier.length > 0 && (
          <div className="glass-panel mt-4 rounded-2xl p-5">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-ld-muted">Per-Supplier Breakdown</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-widest text-ld-muted">
                    <th className="py-1 pr-4">Supplier</th>
                    <th className="py-1 pr-4">Currently Listed</th>
                    <th className="py-1 pr-4">No Longer Listed</th>
                    <th className="py-1 pr-4">Matched</th>
                    <th className="py-1 pr-4">Review Required</th>
                    <th className="py-1 pr-4">New Candidates</th>
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
                      <td className="py-2 pr-4 text-ld-cyan">{s.newCandidates.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="glass-panel mt-6 rounded-2xl p-5">
          <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Recent Uploads</h2>
          {!data || data.recentUploads.length === 0 ? (
            <p className="text-sm text-ld-muted">No supplier price lists uploaded yet.</p>
          ) : (
            <div className="space-y-2">
              {data.recentUploads.map((u) => (
                <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ld-bg-elevated px-4 py-3 text-sm">
                  <div>
                    <span className="font-semibold text-ld-white">{u.filename}</span>{" "}
                    <span className="text-ld-muted">
                      · {u.uploadType} · {new Date(u.startedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-ld-green">{u.autoMatched} matched</span>
                    <span className={u.needsReview > 0 ? "font-semibold text-ld-amber" : "text-ld-muted"}>{u.needsReview} review</span>
                    <span className="text-ld-cyan">{u.newCandidates} new</span>
                    <span
                      className={
                        u.status === "failed"
                          ? "font-bold uppercase text-ld-red"
                          : u.isLive
                            ? "font-bold uppercase text-ld-green"
                            : "font-bold uppercase text-ld-muted"
                      }
                    >
                      {u.status === "failed" ? "Failed" : u.isLive ? "Live" : "Superseded"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
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
