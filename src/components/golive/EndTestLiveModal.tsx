"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { useLiveSession } from "@/context/LiveSessionContext";

type Outcome = "discarded" | "kept" | "cleanup_failed";

/** Discard vs Keep — the "make test data feel temporary" requirement.
 *  Discard is a two-step server operation (end, then delete); this modal
 *  never reports "Discarded" unless `discarded === true` came back from
 *  the server. A cleanup failure leaves the (already-ended) session
 *  fully intact and routes to Test Session History for a retry — real
 *  business data is never at risk either way, since ending a Test Live
 *  only ever touches amoruh:testlive:* keys. */
export function EndTestLiveModal({ onClose, onDone }: { onClose: () => void; onDone: (outcome: Outcome) => void }) {
  const router = useRouter();
  const { endSession } = useLiveSession();
  const [busy, setBusy] = useState<"discard" | "keep" | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const keep = async () => {
    setBusy("keep");
    const result = await endSession(undefined, "keep");
    setBusy(null);
    if (result.ok) onDone("kept");
  };

  const discard = async () => {
    setBusy("discard");
    const result = await endSession(undefined, "discard");
    setBusy(null);
    if (result.discarded) {
      onDone("discarded");
      return;
    }
    // Ended but not actually deleted — never say "Discarded."
    setCleanupError(result.cleanupError ?? "Test session ended, but cleanup did not complete. Retry Delete Test Session.");
  };

  if (cleanupError) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="glass-panel w-full max-w-md rounded-2xl p-6 text-center">
          <p className="font-display text-lg font-bold text-ld-amber">Cleanup Incomplete</p>
          <p className="mt-2 text-sm text-ld-white">{cleanupError}</p>
          <Button
            variant="primary"
            size="lg"
            className="mt-5 w-full"
            onClick={() => {
              onDone("cleanup_failed");
              router.push("/golive/test-history");
            }}
          >
            Go to Test Session History
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="glass-panel w-full max-w-md rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <p className="text-center font-display text-lg font-bold text-ld-white">End Test Live</p>
        <p className="mt-1 text-center text-sm text-ld-muted">What should happen to this rehearsal&apos;s data?</p>

        <div className="mt-5 space-y-3">
          <button
            disabled={busy !== null}
            onClick={keep}
            className="w-full rounded-xl border border-ld-cyan/40 bg-ld-cyan/10 px-4 py-3 text-left transition-colors hover:bg-ld-cyan/15 disabled:opacity-50"
          >
            <p className="font-bold text-ld-cyan">{busy === "keep" ? "Saving…" : "Keep Test Summary"}</p>
            <p className="text-xs text-ld-muted">Review it later in Test Session History.</p>
          </button>
          <button
            disabled={busy !== null}
            onClick={discard}
            className="w-full rounded-xl border border-ld-red/40 bg-ld-red/10 px-4 py-3 text-left transition-colors hover:bg-ld-red/15 disabled:opacity-50"
          >
            <p className="font-bold text-ld-red">{busy === "discard" ? "Discarding…" : "Discard Test Session"}</p>
            <p className="text-xs text-ld-muted">Deletes this rehearsal&apos;s data immediately.</p>
          </button>
        </div>

        <button disabled={busy !== null} onClick={onClose} className="mt-4 w-full text-center text-xs font-semibold text-ld-muted hover:text-ld-white">
          Cancel
        </button>
      </div>
    </div>
  );
}
