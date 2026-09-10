"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Product } from "@/lib/types";
import type { LivePresentation, LiveSession, LiveSessionStats, SellingConfig } from "@/lib/live-types";
import type { SaleRecord } from "@/lib/sales-analytics";

// ---------------------------------------------------------------------
// Go Live's data source — mode-aware since Test Live Mode. `mode` only
// ever changes which URL PREFIX every fetch uses (/api/live/... vs
// /api/live/test/...); every method name, request shape, and response
// shape is identical between the two, so every presentational component
// (ScannerPanel, QueuePanel, SearchPanel, RecentSalesPanel,
// RecordSaleModal, SessionStatsBar) keeps working unmodified regardless
// of which mode is mounted — only CurrentProductPanel (for the TEST MODE
// banner) and the page shell (for the End Test Live control) read `mode`
// off this context directly.
//
// This provider is only ever mounted once a session (real or test)
// already exists — see golive/page.tsx, which checks /api/live/status
// first and renders GoLiveEntryChoice (no provider at all) when neither
// is active. Polling here is a backstop/multi-tab-freshness mechanism,
// not the primary update path — every action already refetches
// immediately after it completes.
// ---------------------------------------------------------------------

const POLL_INTERVAL_MS = 4000;

export type LiveMode = "real" | "test";

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
  /** Only ever present in real mode — Test Mode has no editable selling
   *  config of its own (Break-Even still reads the real one read-only). */
  sellingConfig?: SellingConfig;
}

interface ActionResult {
  ok: boolean;
  error?: string;
  notFound?: boolean;
}

export interface EndSessionResult extends ActionResult {
  /** Test mode only. True only when disposition:"discard" was requested
   *  AND cleanup actually completed — never assume discard succeeded
   *  just because `ok` is true. */
  discarded?: boolean;
  /** Set when a discard's cleanup step failed after the session was
   *  already (successfully) ended — show this message verbatim, never
   *  report "Discarded." */
  cleanupError?: string;
}

interface LiveSessionContextValue {
  mode: LiveMode;
  data: ActiveSnapshot | null;
  loading: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  endSession: (operator?: string, disposition?: "discard" | "keep") => Promise<EndSessionResult>;
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
  /** Real mode only — no-op-shaped for test mode callers, but nothing
   *  in test mode ever renders the control that calls this. */
  updateSellingConfig: (patch: Partial<SellingConfig>, operator?: string) => Promise<ActionResult>;
}

const LiveSessionContext = createContext<LiveSessionContextValue | null>(null);

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** `/api/live/...` in real mode, `/api/live/test/...` in test mode — the
 *  ONE place that decides which storage namespace a request reaches.
 *  `/session/...` paths need the segment inserted after `live`, not
 *  appended, since the real routes live at `/api/live/session/...` too. */
function apiPath(mode: LiveMode, suffix: string): string {
  return mode === "test" ? `/api/live/test${suffix}` : `/api/live${suffix}`;
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

export function LiveSessionProvider({ mode = "real", children }: { mode?: LiveMode; children: React.ReactNode }) {
  const [data, setData] = useState<ActiveSnapshot | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await fetch(apiPath(mode, "/session/active"), { cache: "no-store" });
      if (res.ok) {
        const payload = (await res.json()) as ActiveSnapshot;
        setData(payload);
      }
    } catch {
      // polling backstop below will retry
    } finally {
      refreshingRef.current = false;
    }
  }, [mode]);

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
    async <T extends ActionResult>(fn: () => Promise<T>): Promise<T> => {
      const result = await fn();
      setLastError(result.ok ? null : result.error ?? "Something went wrong.");
      await refresh();
      return result;
    },
    [refresh]
  );

  const endSession = useCallback(
    (operator?: string, disposition?: "discard" | "keep") =>
      runAction(async (): Promise<EndSessionResult> => {
        const sessionId = data?.session?.id;
        if (!sessionId) return { ok: false, error: "No active session." };
        const { ok, data: responseData, error } = await postJson(apiPath(mode, "/session/end"), { sessionId, operator, disposition });
        const body = (responseData ?? {}) as { discarded?: boolean; cleanupError?: string };
        return { ok, error, discarded: body.discarded, cleanupError: body.cleanupError };
      }),
    [runAction, data?.session?.id, mode]
  );

  const scanBarcode = useCallback(
    (code: string, operator?: string) =>
      runAction(async () => {
        const { ok, error, notFound } = await postJson(apiPath(mode, "/scan"), { barcode: code, operator });
        return { ok, error, notFound };
      }),
    [runAction, mode]
  );

  const selectProduct = useCallback(
    (productId: string, operator?: string) =>
      runAction(async () => {
        const { ok, error } = await postJson(apiPath(mode, "/select"), { productId, operator });
        return { ok, error };
      }),
    [runAction, mode]
  );

  const addToQueue = useCallback(
    (productId: string) =>
      runAction(async () => {
        const { ok, error } = await postJson(apiPath(mode, "/queue"), { productId, action: "add" });
        return { ok, error };
      }),
    [runAction, mode]
  );

  const removeFromQueue = useCallback(
    (productId: string) =>
      runAction(async () => {
        const { ok, error } = await postJson(apiPath(mode, "/queue"), { productId, action: "remove" });
        return { ok, error };
      }),
    [runAction, mode]
  );

  const reorderQueue = useCallback(
    (queueIds: string[]) =>
      runAction(async () => {
        const { ok, error } = await postJson(apiPath(mode, "/queue"), { action: "reorder", queueIds });
        return { ok, error };
      }),
    [runAction, mode]
  );

  const nextItem = useCallback(
    () =>
      runAction(async () => {
        const { ok, error } = await postJson(apiPath(mode, "/next"));
        return { ok, error };
      }),
    [runAction, mode]
  );

  const recordSale = useCallback(
    (input: { productId: string; quantity: number; winningBid: number; operator?: string }) =>
      runAction(async () => {
        const { ok, error } = await postJson(apiPath(mode, "/record-sale"), { ...input, idempotencyKey: newIdempotencyKey() });
        return { ok, error };
      }),
    [runAction, mode]
  );

  const noSale = useCallback(
    (productId: string, operator?: string) =>
      runAction(async () => {
        const { ok, error } = await postJson(apiPath(mode, "/no-sale"), { productId, operator, idempotencyKey: newIdempotencyKey() });
        return { ok, error };
      }),
    [runAction, mode]
  );

  const cancelSale = useCallback(
    (saleId: string, operator?: string) =>
      runAction(async () => {
        const { ok, error } = await postJson(apiPath(mode, "/cancel-sale"), { saleId, operator, idempotencyKey: newIdempotencyKey() });
        return { ok, error };
      }),
    [runAction, mode]
  );

  const correctSale = useCallback(
    (saleId: string, newPrice: number, operator?: string) =>
      runAction(async () => {
        const { ok, error } = await postJson(apiPath(mode, "/correct-sale"), {
          saleId,
          newPrice,
          operator,
          idempotencyKey: newIdempotencyKey(),
        });
        return { ok, error };
      }),
    [runAction, mode]
  );

  const updateSellingConfig = useCallback(
    (patch: Partial<SellingConfig>, operator?: string) =>
      runAction(async () => {
        if (mode === "test") return { ok: false, error: "Selling config isn't editable from Test Mode." };
        const res = await fetch("/api/live/selling-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...patch, operator }),
        });
        const payload = await res.json().catch(() => ({}));
        return { ok: res.ok, error: payload?.error };
      }),
    [runAction, mode]
  );

  const value = useMemo<LiveSessionContextValue>(
    () => ({
      mode,
      data,
      loading: data === null,
      lastError,
      refresh,
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
      mode,
      data,
      lastError,
      refresh,
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
