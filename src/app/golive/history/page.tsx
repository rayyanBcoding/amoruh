"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Nav } from "@/components/Nav";
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

export default function LiveHistoryPage() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);

  useEffect(() => {
    fetch("/api/live/session/history?limit=50")
      .then((res) => (res.ok ? res.json() : { sessions: [] }))
      .then((data) => setRows(data.sessions ?? []))
      .catch(() => setRows([]));
  }, []);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1200px] px-6 py-6">
        <h1 className="mb-6 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">Live History</h1>

        {!rows ? (
          <p className="text-ld-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="glass-panel rounded-2xl p-10 text-center text-ld-muted">No Live Sessions yet.</div>
        ) : (
          <div className="glass-panel overflow-hidden rounded-2xl">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-sm">
                <thead>
                  <tr className="border-b border-ld-border text-left text-[10px] font-bold uppercase tracking-widest text-ld-muted">
                    <th className="px-5 py-3">Session</th>
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Duration</th>
                    <th className="px-5 py-3">Revenue</th>
                    <th className="px-5 py-3">Units Sold</th>
                    <th className="px-5 py-3">Profit</th>
                    <th className="px-5 py-3">Sell-Through</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ session, stats }) => (
                    <tr key={session.id} className="border-b border-ld-border/40 last:border-0 hover:bg-ld-bg-elevated">
                      <td className="px-5 py-3">
                        <Link href={`/golive/sessions/${session.id}`} className="font-semibold text-ld-white hover:text-ld-cyan">
                          {session.name}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-ld-muted">
                        {formatDate(session.startedAt)} · {formatTime(session.startedAt)}
                      </td>
                      <td className="px-5 py-3 text-ld-muted">{formatDuration(stats.liveTimeMs)}</td>
                      <td className="px-5 py-3 font-semibold text-ld-green">{formatCurrency(stats.revenue)}</td>
                      <td className="px-5 py-3 text-ld-white">{stats.unitsSold}</td>
                      <td className="px-5 py-3 text-ld-white">
                        {stats.estimatedGrossProfit != null ? formatCurrency(stats.estimatedGrossProfit) : "—"}
                      </td>
                      <td className="px-5 py-3 text-ld-white">
                        {stats.presentationSellThrough != null ? `${Math.round(stats.presentationSellThrough * 100)}%` : "—"}
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
