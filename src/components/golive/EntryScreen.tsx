"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/Button";
import { formatDate, formatTime } from "@/lib/format";
import { useLiveSession } from "@/context/LiveSessionContext";
import type { LiveSession } from "@/lib/live-types";

export function EntryScreen({ recentSessions }: { recentSessions: LiveSession[] }) {
  const { startSession } = useLiveSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

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
        <Button
          variant="primary"
          size="xl"
          className="mt-5 uppercase tracking-wide"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await startSession(name || undefined);
            setBusy(false);
          }}
        >
          {busy ? "Starting…" : "Start Live"}
        </Button>
      </div>

      <div className="text-left">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Recent Live Sessions</h3>
          <Link href="/golive/history" className="text-xs font-semibold text-ld-cyan hover:underline">
            View All →
          </Link>
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
