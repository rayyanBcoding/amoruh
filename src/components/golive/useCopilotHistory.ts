"use client";
import { useEffect, useState } from "react";
import type { ReorderRow } from "@/lib/reorder-intelligence";
import { DEFAULT_WINDOW } from "@/lib/reorder-config";

// Reuse the existing historical-only endpoint, once per session/sale revision
// plus a light freshness backstop. Scanning never waits for this request and
// changing products does NOT restart or fan out history requests.
export function useCopilotHistory(sessionKey: string) {
  const [snapshot, setSnapshot] = useState<{ key: string; rows: ReorderRow[]; state: "ready" | "unavailable" } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const res = await fetch(`/api/reorder-intelligence?window=${DEFAULT_WINDOW}`, { cache: "no-store", signal: abort.signal });
        if (!res.ok) throw new Error("History unavailable");
        const body = await res.json();
        if (!Array.isArray(body.rows)) throw new Error("Invalid history");
        if (!abort.signal.aborted) setSnapshot({ key: sessionKey, rows: body.rows, state: "ready" });
      } catch {
        if (!abort.signal.aborted) setSnapshot({ key: sessionKey, rows: [], state: "unavailable" });
      } finally { running = false; }
    };
    void load();
    const interval = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { abort.abort(); clearInterval(interval); };
  }, [sessionKey]);
  return snapshot?.key === sessionKey ? snapshot : { rows: [], state: "loading" as const };
}
