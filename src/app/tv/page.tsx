"use client";

import { TVStage } from "@/components/tv/TVStage";
import { useLiveState } from "@/context/LiveStateContext";

// Pure customer-facing display, meant to run full-screen on a TV behind the
// auctioneer. No nav, no operator controls, no inventory/shelf data.
export default function TVDisplayPage() {
  const { snapshot, loading } = useLiveState();

  if (loading || !snapshot) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-ld-bg">
        <p className="animate-pulse font-display text-3xl font-bold text-ld-muted">
          Loot Depot OS
        </p>
      </div>
    );
  }

  return <TVStage snapshot={snapshot} />;
}
