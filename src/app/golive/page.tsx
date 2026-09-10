"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { LiveSessionProvider, useLiveSession, type LiveMode } from "@/context/LiveSessionContext";
import { ScannerPanel } from "@/components/golive/ScannerPanel";
import { CurrentProductPanel } from "@/components/golive/CurrentProductPanel";
import { QueuePanel } from "@/components/golive/QueuePanel";
import { SearchPanel } from "@/components/golive/SearchPanel";
import { RecentSalesPanel } from "@/components/golive/RecentSalesPanel";
import { SessionStatsBar } from "@/components/golive/SessionStatsBar";
import { SellingConfigPanel } from "@/components/golive/SellingConfigPanel";
import { GoLiveEntryChoice } from "@/components/golive/GoLiveEntryChoice";
import { EndTestLiveModal } from "@/components/golive/EndTestLiveModal";

function GoLiveScreen({ onExit }: { onExit: () => void }) {
  const router = useRouter();
  const { mode, data, loading, lastError, endSession } = useLiveSession();
  const [ending, setEnding] = useState(false);
  const [showEndTestModal, setShowEndTestModal] = useState(false);

  // The session this provider was mounted for has ended (real End Live,
  // or a Test Live that just got discarded/kept) — hand control back to
  // the page so it re-checks /api/live/status and shows the entry choice
  // instead of this (now mode-stale) screen rendering it itself.
  useEffect(() => {
    if (!loading && data && !data.session) onExit();
  }, [loading, data, onExit]);

  if (loading || !data || !data.session) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="animate-pulse text-ld-muted">Connecting to Go Live…</p>
      </div>
    );
  }

  const session = data.session;

  const endRealLive = async () => {
    if (!window.confirm("End this Live Session? This can't be undone.")) return;
    setEnding(true);
    const result = await endSession();
    setEnding(false);
    if (result.ok) router.push(`/golive/sessions/${session.id}`);
  };

  return (
    <div className="space-y-4">
      {mode === "test" && (
        <div className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ld-amber bg-ld-amber/10 px-4 py-3 text-center text-sm font-extrabold uppercase tracking-widest text-ld-amber">
          🧪 Test Mode — No Real Inventory or Sales Will Be Changed
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
            {mode === "test" && <span className="mr-2 text-ld-amber">[TEST]</span>}
            {session.name}
          </h1>
          <p className="text-sm text-ld-muted">Live since {new Date(session.startedAt).toLocaleTimeString()}</p>
        </div>
        {mode === "test" ? (
          <Button variant="danger" size="md" onClick={() => setShowEndTestModal(true)}>
            End Test Live
          </Button>
        ) : (
          <Button variant="danger" size="md" disabled={ending} onClick={endRealLive}>
            {ending ? "Ending…" : "End Live"}
          </Button>
        )}
      </div>

      {lastError && (
        <div className="rounded-xl border border-ld-red/40 bg-ld-red/10 px-4 py-3 text-sm font-medium text-ld-red">{lastError}</div>
      )}

      {data.stats && <SessionStatsBar stats={data.stats} />}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <div className="glass-panel rounded-2xl p-5">
            <ScannerPanel />
          </div>
          <CurrentProductPanel
            product={data.currentProduct ?? null}
            financials={data.currentProductFinancials ?? null}
            hasQueue={(data.queue?.length ?? 0) > 0}
          />
        </div>

        <div className="space-y-6">
          <QueuePanel queue={data.queue ?? []} />
          <SearchPanel />
          <RecentSalesPanel recent={data.recent ?? []} />
          {mode === "real" && data.sellingConfig && <SellingConfigPanel config={data.sellingConfig} />}
        </div>
      </div>

      {showEndTestModal && (
        <EndTestLiveModal
          onClose={() => setShowEndTestModal(false)}
          onDone={(outcome) => {
            setShowEndTestModal(false);
            if (outcome === "discarded") {
              onExit();
            } else if (outcome === "kept") {
              router.push(`/golive/test-sessions/${session.id}`);
            }
            // outcome === "cleanup_failed" stays on this screen momentarily;
            // the modal itself already routed the operator to Test History.
          }}
        />
      )}
    </div>
  );
}

export default function GoLivePage() {
  const [mode, setMode] = useState<LiveMode | null | "unknown">("unknown");

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/live/status", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      setMode(body?.mode ?? null);
    } catch {
      setMode(null);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick — react-hooks/set-state-in-effect flags any direct
    // call, from an effect body, to a function that can set state.
    Promise.resolve().then(() => {
      void checkStatus();
    });
  }, [checkStatus]);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1600px] px-6 py-6">
        {mode === "unknown" ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <p className="animate-pulse text-ld-muted">Loading…</p>
          </div>
        ) : mode === null ? (
          <GoLiveEntryChoice onStarted={(startedMode) => setMode(startedMode)} />
        ) : (
          <LiveSessionProvider mode={mode} key={mode}>
            <GoLiveScreen onExit={() => setMode(null)} />
          </LiveSessionProvider>
        )}
      </main>
    </div>
  );
}
