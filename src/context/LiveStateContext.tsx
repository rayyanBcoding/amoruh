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
  notFound?: boolean;
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
      return {
        ok: false,
        error: payload?.error ?? `Request failed (${res.status})`,
        notFound: Boolean(payload?.notFound),
      };
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

    const disconnect = () => {
      clearTimeout(retryTimer);
      sourceRef.current?.close();
      sourceRef.current = null;
      setConnected(false);
    };

    const connect = () => {
      if (document.visibilityState === "hidden") return; // resumes on visibilitychange
      disconnect();

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

      source.addEventListener("error", (evt) => {
        if (cancelled) return;
        try {
          const data = JSON.parse((evt as MessageEvent).data) as { message?: string };
          if (data.message) setLastError(`Live sync error: ${data.message}`);
        } catch {
          // not a JSON error frame — ignore
        }
      });

      source.onerror = () => {
        setConnected(false);
        source.close();
        if (!cancelled && document.visibilityState !== "hidden") {
          retryTimer = setTimeout(connect, 2000);
        }
      };
    };

    // Close the connection entirely while the tab is backgrounded — an
    // earlier version kept polling in forgotten background tabs 24/7 and
    // burned through a free-tier Redis request quota in days. Reconnect
    // immediately (and get a fresh snapshot) the moment the tab is visible
    // again.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        disconnect();
      } else {
        connect();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      disconnect();
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
