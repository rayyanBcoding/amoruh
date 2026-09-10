"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Product } from "@/lib/types";
import type { LivePresentation, LiveSession, LiveSessionStats, SellingConfig } from "@/lib/live-types";
import type { SaleRecord } from "@/lib/sales-analytics";

// ---------------------------------------------------------------------
// Go Live's own data source — deliberately separate from
// LiveStateContext (the pre-existing global-snapshot context every other
// page still uses). Editing that context in place to also carry session
// data would destabilize every page that calls useLiveState() for its
// own unrelated SSE snapshot. This context instead polls the one
// composite endpoint (/api/live/session/active) that fully restores the
// Go Live screen — active session, current product + its operator-only
// financials, queue, recent sales/no-sales, live stats, selling config —
// so a refresh or reconnect mid-session is always safe (server-backed,
// nothing lives only in React state).
//
// V1 uses plain polling, not SSE — a Go Live operator's OWN actions
// already refetch immediately after every mutation (see runAction
// below), so polling is purely the multi-tab/backstop freshness
// mechanism, and a few seconds of staleness there is unnoticeable
// mid-auction. Building a second SSE channel just for this isn't
// justified yet — see the approved plan's stated simplifications.
// ---------------------------------------------------------------------

const POLL_INTERVAL_MS = 4000;

export interface RecentSaleView {
  presentation: LivePresentation;
  sale: SaleRecord | null;
  product: Product | null;
}

export interface CurrentProductFinancialsView {
  cost: number | null;
  costSource: "weighted_landed" | "legacy" | "unavailable";
  breakEven: { status: "not_configured" } | { status: "ok"; breakEven: number };
  lastSoldPrice: number | null;
  averageAuction: number | null;
}

interface ActiveSnapshot {
  session: LiveSession | null;
  recentSessions?: LiveSession[];
  currentProduct?: Product | null;
  currentProductFinancials?: CurrentProductFinancialsView | null;
  queue?: Product[];
  recent?: RecentSaleView[];
  stats?: LiveSessionStats;
  sellingConfig: SellingConfig;
}

interface ActionResult {
  ok: boolean;
  error?: string;
  notFound?: boolean;
}

interface LiveSessionContextValue {
  data: ActiveSnapshot | null;
  loading: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  startSession: (name?: string, operator?: string) => Promise<ActionResult>;
  endSession: (operator?: string) => Promise<ActionResult>;
  scanBarcode: (code: string, operator?: string) => Promise<ActionResult>;
  selectProduct: (productId: string, operator?: string) => Promise<ActionResult>;
  addToQueue: (productId: string) => Promise<ActionResult>;
  removeFromQueue: (productId: string) => Promise<ActionResult>;
  reorderQueue: (queueIds: string[]) => Promise<ActionResult>;
  nextItem: () => Promise<ActionResult>;
  recordSale: (input: { productId: string; quantity: number; winningBid: number; operator?: string }) => Promise<ActionResult>;
  noSale: (productId: string, operator?: string) => Promise<ActionResult>;
  cancelSale: (saleId: string, operator?: string) => Promise<ActionResult>;
  correctSale: (saleId: string, newPrice: number, operator?: string) => Promise<ActionResult>;
  updateSellingConfig: (patch: Partial<SellingConfig>, operator?: string) => Promise<ActionResult>;
}

const LiveSessionContext = createContext<LiveSessionContextValue | null>(null);

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function postJson(url: string, body?: unknown): Promise<{ ok: boolean; data: unknown; error?: string; notFound?: boolean }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, data: null, error: payload?.error ?? `Request failed (${res.status})`, notFound: Boolean(payload?.notFound) };
    }
    return { ok: true, data: payload };
  } catch {
    return { ok: false, data: null, error: "Network error — is the server running?" };
  }
}

export function LiveSessionProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<ActiveSnapshot | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await fetch("/api/live/session/active", { cache: "no-store" });
      if (res.ok) {
        const payload = (await res.json()) as ActiveSnapshot;
        setData(payload);
      }
    } catch {
      // polling backstop below will retry
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await refresh();
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refresh]);

  const runAction = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: string; notFound?: boolean }>) => {
      const result = await fn();
      setLastError(result.ok ? null : result.error ?? "Something went wrong.");
      await refresh();
      return result;
    },
    [refresh]
  );

  const startSession = useCallback(
    (name?: string, operator?: string) =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/session/start", { name, operator });
        return { ok, error };
      }),
    [runAction]
  );

  const endSession = useCallback(
    (operator?: string) =>
      runAction(async () => {
        const sessionId = data?.session?.id;
        if (!sessionId) return { ok: false, error: "No active session." };
        const { ok, error } = await postJson("/api/live/session/end", { sessionId, operator });
        return { ok, error };
      }),
    [runAction, data?.session?.id]
  );

  const scanBarcode = useCallback(
    (code: string, operator?: string) =>
      runAction(async () => {
        const { ok, error, notFound } = await postJson("/api/live/scan", { barcode: code, operator });
        return { ok, error, notFound };
      }),
    [runAction]
  );

  const selectProduct = useCallback(
    (productId: string, operator?: string) =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/select", { productId, operator });
        return { ok, error };
      }),
    [runAction]
  );

  const addToQueue = useCallback(
    (productId: string) =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/queue", { productId, action: "add" });
        return { ok, error };
      }),
    [runAction]
  );

  const removeFromQueue = useCallback(
    (productId: string) =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/queue", { productId, action: "remove" });
        return { ok, error };
      }),
    [runAction]
  );

  const reorderQueue = useCallback(
    (queueIds: string[]) =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/queue", { action: "reorder", queueIds });
        return { ok, error };
      }),
    [runAction]
  );

  const nextItem = useCallback(
    () =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/next");
        return { ok, error };
      }),
    [runAction]
  );

  const recordSale = useCallback(
    (input: { productId: string; quantity: number; winningBid: number; operator?: string }) =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/record-sale", { ...input, idempotencyKey: newIdempotencyKey() });
        return { ok, error };
      }),
    [runAction]
  );

  const noSale = useCallback(
    (productId: string, operator?: string) =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/no-sale", { productId, operator, idempotencyKey: newIdempotencyKey() });
        return { ok, error };
      }),
    [runAction]
  );

  const cancelSale = useCallback(
    (saleId: string, operator?: string) =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/cancel-sale", { saleId, operator, idempotencyKey: newIdempotencyKey() });
        return { ok, error };
      }),
    [runAction]
  );

  const correctSale = useCallback(
    (saleId: string, newPrice: number, operator?: string) =>
      runAction(async () => {
        const { ok, error } = await postJson("/api/live/correct-sale", {
          saleId,
          newPrice,
          operator,
          idempotencyKey: newIdempotencyKey(),
        });
        return { ok, error };
      }),
    [runAction]
  );

  const updateSellingConfig = useCallback(
    (patch: Partial<SellingConfig>, operator?: string) =>
      runAction(async () => {
        const res = await fetch("/api/live/selling-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...patch, operator }),
        });
        const payload = await res.json().catch(() => ({}));
        return { ok: res.ok, error: payload?.error };
      }),
    [runAction]
  );

  const value = useMemo<LiveSessionContextValue>(
    () => ({
      data,
      loading: data === null,
      lastError,
      refresh,
      startSession,
      endSession,
      scanBarcode,
      selectProduct,
      addToQueue,
      removeFromQueue,
      reorderQueue,
      nextItem,
      recordSale,
      noSale,
      cancelSale,
      correctSale,
      updateSellingConfig,
    }),
    [
      data,
      lastError,
      refresh,
      startSession,
      endSession,
      scanBarcode,
      selectProduct,
      addToQueue,
      removeFromQueue,
      reorderQueue,
      nextItem,
      recordSale,
      noSale,
      cancelSale,
      correctSale,
      updateSellingConfig,
    ]
  );

  return <LiveSessionContext.Provider value={value}>{children}</LiveSessionContext.Provider>;
}

export function useLiveSession() {
  const ctx = useContext(LiveSessionContext);
  if (!ctx) throw new Error("useLiveSession must be used within a LiveSessionProvider");
  return ctx;
}
