"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { formatCurrency, formatDate, formatTime } from "@/lib/format";
import type { LiveSession, LiveSessionStats } from "@/lib/live-types";

interface HistoryRow {
  session: LiveSession;
  stats: LiveSessionStats;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// Fully separate storage (amoruh:testlive:*) from real Live History —
// nothing shown here ever contributes to production Dashboard/analytics.
export default function TestLiveHistoryPage() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/live/test/session/history?limit=50")
      .then((res) => (res.ok ? res.json() : { sessions: [] }))
      .then((data) => setRows(data.sessions ?? []))
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const deleteSession = async (id: string) => {
    if (!window.confirm("Delete this Test Session permanently? This cannot be undone.")) return;
    setDeletingId(id);
    setError(null);
    const res = await fetch(`/api/live/test/session/${id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    setDeletingId(null);
    if (!res.ok) {
      setError(body?.error ?? "Could not delete this Test Session.");
      return;
    }
    load();
  };

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1200px] px-6 py-6">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
            <span className="mr-2 text-ld-amber">🧪</span>Test Session History
          </h1>
          <Link href="/golive">
            <Button variant="outline" size="md">
              Back to Go Live
            </Button>
          </Link>
        </div>

        {error && <div className="mb-4 rounded-xl border border-ld-red/40 bg-ld-red/10 px-4 py-3 text-sm text-ld-red">{error}</div>}

        {!rows ? (
          <p className="text-ld-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="glass-panel rounded-2xl p-10 text-center text-ld-muted">No Test Sessions yet.</div>
        ) : (
          <div className="glass-panel overflow-hidden rounded-2xl">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[850px] text-sm">
                <thead>
                  <tr className="border-b border-ld-border text-left text-[10px] font-bold uppercase tracking-widest text-ld-muted">
                    <th className="px-5 py-3">Session</th>
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Duration</th>
                    <th className="px-5 py-3">Simulated Revenue</th>
                    <th className="px-5 py-3">Units Sold</th>
                    <th className="px-5 py-3">Sell-Through</th>
                    <th className="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ session, stats }) => (
                    <tr key={session.id} className="border-b border-ld-border/40 last:border-0 hover:bg-ld-bg-elevated">
                      <td className="px-5 py-3">
                        <Link href={`/golive/test-sessions/${session.id}`} className="font-semibold text-ld-white hover:text-ld-cyan">
                          {session.name}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-ld-muted">
                        {formatDate(session.startedAt)} · {formatTime(session.startedAt)}
                      </td>
                      <td className="px-5 py-3 text-ld-muted">{formatDuration(stats.liveTimeMs)}</td>
                      <td className="px-5 py-3 font-semibold text-ld-amber">{formatCurrency(stats.revenue)}</td>
                      <td className="px-5 py-3 text-ld-white">{stats.unitsSold}</td>
                      <td className="px-5 py-3 text-ld-white">
                        {stats.presentationSellThrough != null ? `${Math.round(stats.presentationSellThrough * 100)}%` : "—"}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          disabled={deletingId !== null}
                          onClick={() => deleteSession(session.id)}
                          className="rounded-lg bg-ld-red/15 px-3 py-1.5 text-xs font-bold text-ld-red hover:bg-ld-red/25 disabled:opacity-50"
                        >
                          {deletingId === session.id ? "Deleting…" : "Delete"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
