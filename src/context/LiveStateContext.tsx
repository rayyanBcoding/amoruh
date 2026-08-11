"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LiveSnapshot } from "@/lib/types";

interface ActionResult {
  ok: boolean;
  error?: string;
}

interface LiveStateContextValue {
  snapshot: LiveSnapshot | null;
  connected: boolean;
  loading: boolean;
  lastError: string | null;
  scanBarcode: (code: string) => Promise<ActionResult>;
  nextProduct: () => Promise<ActionResult>;
  markSold: () => Promise<ActionResult>;
  toggleFlashDeal: (discountPercent?: number) => Promise<ActionResult>;
  selectProduct: (productId: string) => Promise<ActionResult>;
  addToQueue: (productId: string) => Promise<ActionResult>;
  removeFromQueue: (productId: string) => Promise<ActionResult>;
}

const LiveStateContext = createContext<LiveStateContextValue | null>(null);

async function postJson(url: string, body?: unknown): Promise<ActionResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      return { ok: false, error: payload?.error ?? `Request failed (${res.status})` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error — is the server running?" };
  }
}

export function LiveStateProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const source = new EventSource("/api/events");
      sourceRef.current = source;

      source.addEventListener("snapshot", (evt) => {
        if (cancelled) return;
        try {
          const data = JSON.parse((evt as MessageEvent).data) as LiveSnapshot;
          setSnapshot(data);
          setConnected(true);
        } catch {
          // ignore malformed frame
        }
      });

      source.onerror = () => {
        setConnected(false);
        source.close();
        if (!cancelled) {
          retryTimer = setTimeout(connect, 2000);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      sourceRef.current?.close();
    };
  }, []);

  const scanBarcode = useCallback(async (code: string) => {
    const result = await postJson("/api/scan", { barcode: code });
    setLastError(result.ok ? null : result.error ?? "Scan failed");
    return result;
  }, []);

  const nextProduct = useCallback(async () => {
    const result = await postJson("/api/state/next");
    setLastError(result.ok ? null : result.error ?? "Could not advance queue");
    return result;
  }, []);

  const markSold = useCallback(async () => {
    const result = await postJson("/api/state/sold");
    setLastError(result.ok ? null : result.error ?? "Could not mark sold");
    return result;
  }, []);

  const toggleFlashDeal = useCallback(async (discountPercent?: number) => {
    const result = await postJson("/api/state/flash-deal", { discountPercent });
    setLastError(result.ok ? null : result.error ?? "Could not toggle flash deal");
    return result;
  }, []);

  const selectProduct = useCallback(async (productId: string) => {
    const result = await postJson("/api/state/select", { productId });
    setLastError(result.ok ? null : result.error ?? "Could not select product");
    return result;
  }, []);

  const addToQueue = useCallback(async (productId: string) => {
    const result = await postJson("/api/state/queue", { productId, action: "add" });
    setLastError(result.ok ? null : result.error ?? "Could not add to queue");
    return result;
  }, []);

  const removeFromQueue = useCallback(async (productId: string) => {
    const result = await postJson("/api/state/queue", { productId, action: "remove" });
    setLastError(result.ok ? null : result.error ?? "Could not update queue");
    return result;
  }, []);

  const value = useMemo<LiveStateContextValue>(
    () => ({
      snapshot,
      connected,
      loading: snapshot === null,
      lastError,
      scanBarcode,
      nextProduct,
      markSold,
      toggleFlashDeal,
      selectProduct,
      addToQueue,
      removeFromQueue,
    }),
    [
      snapshot,
      connected,
      lastError,
      scanBarcode,
      nextProduct,
      markSold,
      toggleFlashDeal,
      selectProduct,
      addToQueue,
      removeFromQueue,
    ]
  );

  return <LiveStateContext.Provider value={value}>{children}</LiveStateContext.Provider>;
}

export function useLiveState() {
  const ctx = useContext(LiveStateContext);
  if (!ctx) {
    throw new Error("useLiveState must be used within a LiveStateProvider");
  }
  return ctx;
}
