"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/Button";
import { formatDate, formatTime } from "@/lib/format";
import type { LiveSession } from "@/lib/live-types";
import type { LiveMode } from "@/context/LiveSessionContext";

/** Renders BEFORE any LiveSessionProvider exists — /golive/page.tsx only
 *  mounts the provider once a mode is actually decided (see
 *  /api/live/status). Start Live / Start Test Live each call their own
 *  endpoint directly (not through the context, which needs a mode to
 *  already be settled) and report back which mode won so the page can
 *  mount the provider in that mode. */
export function GoLiveEntryChoice({ onStarted }: { onStarted: (mode: LiveMode) => void }) {
  const [name, setName] = useState("");
  const [recentSessions, setRecentSessions] = useState<LiveSession[]>([]);
  const [busy, setBusy] = useState<LiveMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/live/session/active")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !data.session) setRecentSessions(data.recentSessions ?? []);
      })
      .catch(() => {});
  }, []);

  const start = async (mode: LiveMode) => {
    setBusy(mode);
    setError(null);
    const url = mode === "real" ? "/api/live/session/start" : "/api/live/test/session/start";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() || undefined }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(body?.error ?? `Could not start ${mode === "test" ? "Test Live" : "Live"}.`);
      return;
    }
    onStarted(mode);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-10 text-center">
      <div className="glass-panel rounded-2xl p-10">
        <p className="font-display text-2xl font-extrabold uppercase tracking-widest text-ld-muted">No Active Live Session</p>
        <div className="mx-auto mt-6 max-w-sm">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Session name (optional)"
            className="w-full rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-3 text-center text-sm text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple"
          />
        </div>

        {error && <p className="mt-3 text-sm font-semibold text-ld-red">{error}</p>}

        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <Button variant="primary" size="xl" className="uppercase tracking-wide" disabled={busy !== null} onClick={() => start("real")}>
            {busy === "real" ? "Starting…" : "Start Live"}
          </Button>
          <Button
            variant="outline"
            size="xl"
            className="border-dashed border-ld-amber/50 uppercase tracking-wide text-ld-amber hover:bg-ld-amber/10"
            disabled={busy !== null}
            onClick={() => start("test")}
          >
            {busy === "test" ? "Starting…" : "🧪 Start Test Live"}
          </Button>
        </div>
        <p className="mt-3 text-xs text-ld-muted">
          Test Live rehearses the full workflow against real products — no real inventory or sales are ever changed.
        </p>
      </div>

      <div className="text-left">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Recent Live Sessions</h3>
          <div className="flex items-center gap-4">
            <Link href="/golive/history" className="text-xs font-semibold text-ld-cyan hover:underline">
              View All →
            </Link>
            <Link href="/golive/test-history" className="text-xs font-semibold text-ld-amber hover:underline">
              Test Sessions →
            </Link>
          </div>
        </div>
        {recentSessions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-ld-border p-6 text-center text-sm text-ld-muted">
            No Live Sessions yet.
          </p>
        ) : (
          <div className="space-y-2">
            {recentSessions.map((s) => (
              <Link
                key={s.id}
                href={`/golive/sessions/${s.id}`}
                className="flex items-center justify-between rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-3 text-sm hover:border-ld-purple/50"
              >
                <span className="font-semibold text-ld-white">{s.name}</span>
                <span className="text-xs text-ld-muted">
                  {formatDate(s.startedAt)} · {formatTime(s.startedAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
