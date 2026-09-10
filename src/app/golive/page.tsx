"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { LiveSessionProvider, useLiveSession } from "@/context/LiveSessionContext";
import { ScannerPanel } from "@/components/golive/ScannerPanel";
import { CurrentProductPanel } from "@/components/golive/CurrentProductPanel";
import { QueuePanel } from "@/components/golive/QueuePanel";
import { SearchPanel } from "@/components/golive/SearchPanel";
import { RecentSalesPanel } from "@/components/golive/RecentSalesPanel";
import { SessionStatsBar } from "@/components/golive/SessionStatsBar";
import { SellingConfigPanel } from "@/components/golive/SellingConfigPanel";
import { EntryScreen } from "@/components/golive/EntryScreen";

function GoLiveScreen() {
  const router = useRouter();
  const { data, loading, lastError, endSession } = useLiveSession();
  const [ending, setEnding] = useState(false);

  if (loading || !data) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="animate-pulse text-ld-muted">Connecting to Go Live…</p>
      </div>
    );
  }

  if (!data.session) {
    return <EntryScreen recentSessions={data.recentSessions ?? []} />;
  }

  const session = data.session;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">{session.name}</h1>
          <p className="text-sm text-ld-muted">Live since {new Date(session.startedAt).toLocaleTimeString()}</p>
        </div>
        <Button
          variant="danger"
          size="md"
          disabled={ending}
          onClick={async () => {
            if (!window.confirm("End this Live Session? This can't be undone.")) return;
            setEnding(true);
            const result = await endSession();
            setEnding(false);
            if (result.ok) router.push(`/golive/sessions/${session.id}`);
          }}
        >
          {ending ? "Ending…" : "End Live"}
        </Button>
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
          <SellingConfigPanel config={data.sellingConfig} />
        </div>
      </div>
    </div>
  );
}

export default function GoLivePage() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <LiveSessionProvider>
          <GoLiveScreen />
        </LiveSessionProvider>
      </main>
    </div>
  );
}
