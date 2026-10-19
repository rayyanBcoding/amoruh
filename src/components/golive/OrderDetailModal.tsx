"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { OrderDetail } from "@/lib/live-db";
import type { SaleAuditEvent } from "@/lib/sales-analytics";
import type { Product } from "@/lib/types";
import { Button } from "@/components/Button";
import { formatCurrency, formatDate, formatTime } from "@/lib/format";

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function money(v: unknown): string {
  return typeof v === "number" ? formatCurrency(v) : "—";
}

/** One compact, human line per audit event, e.g. "price: $65 → $70". */
function describeEvent(e: SaleAuditEvent): string {
  const b = e.before ?? {};
  const a = e.after ?? {};
  switch (e.action) {
    case "created":
      return `Recorded — ${money(a.price)} × ${a.quantity ?? 1}`;
    case "price_changed":
      return `price: ${money(b.price)} → ${money(a.price)}`;
    case "quantity_changed":
      return `quantity: ${b.quantity} → ${a.quantity}`;
    case "product_changed":
      return `product: ${b.name ?? b.sku} → ${a.name ?? a.sku} (cost ${money(b.landedCostAtSale)} → ${money(a.landedCostAtSale)})`;
    case "canceled":
      return "Canceled — inventory restored";
    case "restored":
      return "Restored — inventory decremented again";
    default:
      return e.action;
  }
}

const ACTION_LABEL: Record<SaleAuditEvent["action"], string> = {
  created: "Created",
  price_changed: "Price changed",
  quantity_changed: "Quantity changed",
  product_changed: "Product changed",
  canceled: "Canceled",
  restored: "Restored",
};

interface OrderDetailModalProps {
  saleId: string;
  readOnly?: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function OrderDetailModal({ saleId, readOnly = false, onClose, onChanged }: OrderDetailModalProps) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [newProduct, setNewProduct] = useState<Product | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [productQuery, setProductQuery] = useState("");
  const [confirm, setConfirm] = useState<"cancel" | "restore" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionKey = useRef<string>(newKey());

  const load = async () => {
    try {
      const res = await fetch(`/api/live/orders/${saleId}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(body?.error ?? "Could not load this order.");
        return;
      }
      const d = body as OrderDetail;
      setDetail(d);
      setPrice(String(d.row.sale.price));
      setQuantity(String(d.row.sale.quantity));
      setNewProduct(null);
      setProductQuery("");
    } catch {
      setLoadError("Network error.");
    }
  };

  useEffect(() => {
    // deferred a tick — react-hooks/set-state-in-effect flags a direct call
    Promise.resolve().then(() => void load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sale = detail?.row.sale;
  const editable = Boolean(detail?.editable) && !readOnly;
  const active = detail?.row.status === "active";

  const ensureProducts = async () => {
    if (products) return;
    try {
      const res = await fetch("/api/products");
      const data = await res.json();
      setProducts(Array.isArray(data) ? data : []);
    } catch {
      setProducts([]);
    }
  };

  const matches = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q || !products) return [];
    return products
      .filter((p) => `${p.brand} ${p.name} ${p.size}`.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q))
      .slice(0, 6);
  }, [products, productQuery]);

  const changes = useMemo(() => {
    if (!sale) return {};
    const out: { newPrice?: number; newQuantity?: number; newProductId?: string } = {};
    const p = Number(price);
    const q = Number(quantity);
    if (Number.isFinite(p) && price.trim() !== "" && p !== sale.price) out.newPrice = p;
    if (Number.isFinite(q) && quantity.trim() !== "" && q !== sale.quantity) out.newQuantity = q;
    if (newProduct && newProduct.id !== sale.productId) out.newProductId = newProduct.id;
    return out;
  }, [sale, price, quantity, newProduct]);
  const hasChanges = Object.keys(changes).length > 0;

  const run = async (url: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saleId, ...body, idempotencyKey: actionKey.current }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload?.error ?? `Request failed (${res.status}).`);
        return;
      }
      actionKey.current = newKey(); // success: the next action is a new action
      setConfirm(null);
      await load();
      onChanged();
    } catch {
      setError("Network error — nothing was changed that you can't retry safely.");
    } finally {
      setBusy(false);
    }
  };

  const title = detail?.row.product ? `${detail.row.product.brand} ${detail.row.product.name}`.trim() : sale?.sku ?? "";
  const f = detail?.row.financials;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="glass-panel max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
        {loadError ? (
          <p className="text-sm font-medium text-ld-red">{loadError}</p>
        ) : !detail || !sale ? (
          <p className="animate-pulse text-ld-muted">Loading order…</p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-ld-muted">
                  LIVE Order {sale.liveOrderNumber != null ? `#${sale.liveOrderNumber}` : "(no number — recorded before order numbers)"}
                </p>
                <h2 className="mt-1 text-lg font-semibold text-ld-white">{title}</h2>
                <p className="text-xs text-ld-muted">
                  {formatDate(sale.soldAt)} · {formatTime(sale.soldAt)} · SKU {sale.sku}
                  {detail.session && ` · ${detail.session.name}`}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${
                  active ? "bg-ld-green/15 text-ld-green" : "bg-ld-red/15 text-ld-red"
                }`}
              >
                {active ? "Active" : "Canceled"}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Price", formatCurrency(sale.price)],
                ["Quantity", String(sale.quantity)],
                ["Unit cost", f?.unitCost != null ? formatCurrency(f.unitCost) : "—"],
                ["Total cost", f?.totalCost != null ? formatCurrency(f.totalCost) : "—"],
                ["Profit", f?.profit != null ? formatCurrency(f.profit) : "—"],
                ["Margin", f?.margin != null ? `${(f.margin * 100).toFixed(1)}%` : "—"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-ld-border bg-ld-bg-elevated p-3 text-center">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
                  <p className="mt-0.5 font-display text-base font-extrabold text-ld-white">{value}</p>
                </div>
              ))}
            </div>
            {f?.unitCost == null && (
              <p className="mt-2 text-xs text-ld-muted">No cost basis was recorded for this product when it sold, so profit can&apos;t be calculated.</p>
            )}

            {!editable && (
              <p className="mt-4 rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-xs text-ld-muted">
                {detail.editable === false && detail.session?.status === "ended"
                  ? "This Live has ended — its orders are read-only."
                  : "Read-only."}
              </p>
            )}

            {editable && active && (
              <form
                className="mt-5 space-y-3 rounded-xl border border-ld-border p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (hasChanges) void run("/api/live/edit-sale", changes);
                }}
              >
                <p className="text-xs font-bold uppercase tracking-widest text-ld-muted">Edit order</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs font-semibold text-ld-muted">
                    Selling price {sale.quantity > 1 || Number(quantity) > 1 ? "(total)" : ""}
                    <input
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      inputMode="decimal"
                      className="mt-1 w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
                    />
                  </label>
                  <label className="block text-xs font-semibold text-ld-muted">
                    Quantity
                    <input
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      inputMode="numeric"
                      className="mt-1 w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
                    />
                  </label>
                </div>
                <div>
                  <p className="text-xs font-semibold text-ld-muted">Product</p>
                  {newProduct ? (
                    <div className="mt-1 flex items-center justify-between rounded-lg border border-ld-amber/50 bg-ld-amber/10 px-3 py-2 text-sm text-ld-white">
                      <span>
                        Change to <strong>{newProduct.brand} {newProduct.name}</strong> {newProduct.size}
                        <span className="block text-[11px] text-ld-muted">
                          Stock returns to the original product and is taken from this one; its cost becomes the cost at the time of this edit.
                        </span>
                      </span>
                      <button type="button" onClick={() => setNewProduct(null)} className="text-xs font-semibold text-ld-muted hover:text-ld-white">
                        Undo
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        value={productQuery}
                        onFocus={() => void ensureProducts()}
                        onChange={(e) => {
                          void ensureProducts();
                          setProductQuery(e.target.value);
                        }}
                        placeholder="Change product — search name, SKU or barcode"
                        className="mt-1 w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
                      />
                      {matches.length > 0 && (
                        <div className="mt-1 overflow-hidden rounded-lg border border-ld-border">
                          {matches.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => {
                                setNewProduct(p);
                                setProductQuery("");
                              }}
                              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-ld-white hover:bg-ld-bg-elevated"
                            >
                              <span>
                                {p.brand} {p.name} <span className="text-ld-muted">{p.size}</span>
                              </span>
                              <span className="text-xs text-ld-muted">in stock {p.inventory}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {error && <p className="text-sm font-medium text-ld-red">{error}</p>}
                <div className="flex items-center gap-2">
                  <Button type="submit" variant="cyan" size="md" disabled={busy || !hasChanges}>
                    {busy && !confirm ? "Saving…" : "Save changes"}
                  </Button>
                  {!hasChanges && <span className="text-xs text-ld-muted">Change a value to save.</span>}
                </div>
              </form>
            )}

            {editable && (
              <div className="mt-4">
                {confirm === null ? (
                  active ? (
                    <Button variant="danger" size="md" onClick={() => setConfirm("cancel")} disabled={busy}>
                      Cancel order
                    </Button>
                  ) : (
                    <Button variant="cyan" size="md" onClick={() => setConfirm("restore")} disabled={busy}>
                      Restore order
                    </Button>
                  )
                ) : (
                  <div className="rounded-xl border border-ld-amber/50 bg-ld-amber/10 p-4">
                    <p className="text-sm font-semibold text-ld-white">
                      {confirm === "cancel"
                        ? `Cancel order #${sale.liveOrderNumber ?? ""}? Its stock goes back to inventory and it stops counting toward this Live's totals. You can restore it afterwards.`
                        : `Restore order #${sale.liveOrderNumber ?? ""}? It becomes active again under the same number and its stock is taken out of inventory again.`}
                    </p>
                    {error && <p className="mt-2 text-sm font-medium text-ld-red">{error}</p>}
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant={confirm === "cancel" ? "danger" : "cyan"}
                        size="md"
                        disabled={busy}
                        onClick={() => void run(confirm === "cancel" ? "/api/live/cancel-sale" : "/api/live/restore-sale", {})}
                      >
                        {busy ? "Working…" : confirm === "cancel" ? "Yes, cancel order" : "Yes, restore order"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="md"
                        disabled={busy}
                        onClick={() => {
                          setConfirm(null);
                          setError(null);
                        }}
                      >
                        Back
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="mt-6">
              <p className="mb-2 text-xs font-bold uppercase tracking-widest text-ld-muted">History</p>
              {detail.audit.length === 0 ? (
                <p className="text-xs text-ld-muted">No recorded changes (this order predates the audit trail).</p>
              ) : (
                <ol className="space-y-2 border-l border-ld-border pl-4">
                  {detail.audit.map((e) => (
                    <li key={e.id} className="relative">
                      <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-ld-purple" />
                      <p className="text-sm font-semibold text-ld-white">
                        {ACTION_LABEL[e.action] ?? e.action}
                        <span className="ml-2 text-xs font-normal text-ld-muted">
                          {formatDate(e.at)} · {formatTime(e.at)} · {e.operator}
                        </span>
                      </p>
                      <p className="text-xs text-ld-muted">{describeEvent(e)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <Button variant="ghost" size="md" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
