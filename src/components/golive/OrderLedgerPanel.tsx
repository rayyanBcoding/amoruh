"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrderLedgerPage, OrderLedgerRow, OrderLedgerStatusFilter } from "@/lib/live-db";
import { formatCurrency, formatTime } from "@/lib/format";
import { OrderDetailModal } from "@/components/golive/OrderDetailModal";

const PAGE_SIZE = 50;
const POLL_MS = 10_000;

const FILTERS: { value: OrderLedgerStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "canceled", label: "Canceled" },
];

function OrderRow({ row, onOpen }: { row: OrderLedgerRow; onOpen: () => void }) {
  const { sale, product, financials, status } = row;
  const canceled = status === "canceled";
  const title = product ? `${product.brand} ${product.name}`.trim() : sale.sku;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`grid w-full grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-xl border px-3 py-2 text-left transition hover:border-ld-purple/60 sm:grid-cols-[3.5rem_minmax(0,1fr)_4rem_5rem_5.5rem_7rem_4.5rem_5.5rem] ${
        canceled ? "border-ld-red/30 bg-ld-red/5" : "border-ld-border bg-ld-bg-elevated"
      }`}
    >
      <span className="font-display text-base font-extrabold text-ld-white">
        {sale.liveOrderNumber != null ? `#${sale.liveOrderNumber}` : "—"}
      </span>
      <span className="min-w-0">
        <span className={`block truncate text-sm font-semibold ${canceled ? "text-ld-muted line-through" : "text-ld-white"}`}>{title}</span>
        <span className="block truncate text-[11px] text-ld-muted sm:hidden">
          {formatTime(sale.soldAt)} · cost {financials.totalCost != null ? formatCurrency(financials.totalCost) : "—"}
        </span>
      </span>
      <span className="hidden text-xs text-ld-muted sm:block">×{sale.quantity}</span>
      <span className={`text-sm font-bold ${canceled ? "text-ld-red line-through" : "text-ld-green"}`}>{formatCurrency(sale.price)}</span>
      <span className="hidden text-xs text-ld-muted sm:block">
        cost {financials.totalCost != null ? formatCurrency(financials.totalCost) : "—"}
      </span>
      <span className="hidden text-xs sm:block">
        {financials.profit != null ? (
          <span className={financials.profit < 0 ? "font-semibold text-ld-red" : "font-semibold text-ld-white"}>
            profit {formatCurrency(financials.profit)}
            {financials.margin != null && <span className="font-normal text-ld-muted"> ({Math.round(financials.margin * 100)}%)</span>}
          </span>
        ) : (
          <span className="text-ld-muted">profit —</span>
        )}
      </span>
      <span className="hidden text-[11px] text-ld-muted sm:block">{formatTime(sale.soldAt)}</span>
      <span
        className={`justify-self-end rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
          canceled ? "bg-ld-red/15 text-ld-red" : "bg-ld-green/15 text-ld-green"
        }`}
      >
        {canceled ? "Canceled" : "Active"}
      </span>
    </button>
  );
}

interface OrderLedgerPanelProps {
  /** Omit for the currently active Live. */
  sessionId?: string;
  /** Ended Lives: the ledger is browse-only. */
  readOnly?: boolean;
  /** Bump to refetch (e.g. after a sale is recorded elsewhere on the page). */
  refreshToken?: number;
  /** Called after an edit / cancel / restore succeeds so the page can refresh its totals. */
  onChanged?: () => void;
}

/** The full, searchable order ledger of ONE Live Session. Reads the session's
 *  complete order set from the server (never the capped recent-sales list) and
 *  pages through it: newest first, exact `#N` matches float to the top. */
export function OrderLedgerPanel({ sessionId, readOnly = false, refreshToken = 0, onChanged }: OrderLedgerPanelProps) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<OrderLedgerStatusFilter>("all");
  const [page, setPage] = useState<OrderLedgerPage | null>(null);
  const [rows, setRows] = useState<OrderLedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSaleId, setOpenSaleId] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const loadedCount = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const fetchPage = useCallback(
    async (offset: number, limit: number, append: boolean) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: debounced, status, offset: String(offset), limit: String(limit) });
        if (sessionId) params.set("sessionId", sessionId);
        const res = await fetch(`/api/live/orders?${params}`, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (seq !== requestSeq.current) return; // a newer request superseded this one
        if (!res.ok) {
          setError(body?.error ?? "Could not load orders.");
          return;
        }
        const next = body as OrderLedgerPage;
        setError(null);
        setPage(next);
        setRows((prev) => {
          const merged = append ? [...prev, ...next.rows] : next.rows;
          loadedCount.current = merged.length;
          return merged;
        });
      } catch {
        if (seq === requestSeq.current) setError("Network error — retrying.");
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [sessionId, debounced, status]
  );

  // switching filter/search starts a fresh list
  useEffect(() => {
    loadedCount.current = 0;
  }, [debounced, status, sessionId]);

  // new search/filter/session/refresh → reload from the top (keeping as many rows as were already open)
  useEffect(() => {
    // deferred a tick — react-hooks/set-state-in-effect flags a direct call
    Promise.resolve().then(() => void fetchPage(0, Math.max(PAGE_SIZE, loadedCount.current), false));
  }, [fetchPage, refreshToken]);

  useEffect(() => {
    if (readOnly) return;
    const id = setInterval(() => void fetchPage(0, Math.max(PAGE_SIZE, loadedCount.current), false), POLL_MS);
    return () => clearInterval(id);
  }, [fetchPage, readOnly]);

  const counts = page?.counts;

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-sm font-bold uppercase tracking-widest text-ld-muted">Orders</h3>
          {counts && (
            <p className="mt-0.5 text-xs text-ld-muted">
              <span className="font-semibold text-ld-white">{counts.entered}</span> entered ·{" "}
              <span className="font-semibold text-ld-green">{counts.active}</span> active ·{" "}
              <span className="font-semibold text-ld-red">{counts.canceled}</span> canceled
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search #, product, SKU, barcode"
            aria-label="Search orders"
            className="w-64 rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
          />
          <div className="flex rounded-lg border border-ld-border p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatus(f.value)}
                className={`rounded-md px-3 py-1.5 text-xs font-bold ${
                  status === f.value ? "bg-ld-purple text-ld-white" : "text-ld-muted hover:text-ld-white"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <p className="mb-2 text-sm font-medium text-ld-red">{error}</p>}

      {rows.length === 0 && !loading ? (
        <p className="rounded-xl border border-dashed border-ld-border p-4 text-center text-sm text-ld-muted">
          {counts && counts.entered > 0 ? "No orders match this search." : "No orders recorded yet."}
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <OrderRow key={row.sale.id} row={row} onOpen={() => setOpenSaleId(row.sale.id)} />
          ))}
        </div>
      )}

      {page?.hasMore && (
        <div className="mt-3 text-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => void fetchPage(rows.length, PAGE_SIZE, true)}
            className="rounded-lg border border-ld-border px-4 py-2 text-xs font-bold text-ld-cyan hover:bg-ld-bg-elevated disabled:opacity-50"
          >
            {loading ? "Loading…" : `Show more (${page.total - rows.length} left)`}
          </button>
        </div>
      )}

      {openSaleId && (
        <OrderDetailModal
          saleId={openSaleId}
          readOnly={readOnly}
          onClose={() => setOpenSaleId(null)}
          onChanged={() => {
            void fetchPage(0, Math.max(PAGE_SIZE, loadedCount.current), false);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
