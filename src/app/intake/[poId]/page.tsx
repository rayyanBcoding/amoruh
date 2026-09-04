"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { POStatusBadge, LineStatusBadge, MatchBadge } from "@/components/intake/IntakeBadges";
import { formatCurrency, formatDate } from "@/lib/format";
import type { InvoiceDocument, PurchaseOrder, PurchaseOrderLine } from "@/lib/intake-types";
import type { Product } from "@/lib/types";

interface Detail {
  po: PurchaseOrder;
  lines: PurchaseOrderLine[];
  document: InvoiceDocument | null;
}

export default function PODetailPage() {
  const params = useParams<{ poId: string }>();
  const [detail, setDetail] = useState<Detail | null | undefined>(undefined);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shippingInput, setShippingInput] = useState("");
  const [savingShipping, setSavingShipping] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/intake/pos/${params.poId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setDetail(data);
        if (data) setShippingInput(String(data.po.shippingCost ?? 0));
      })
      .catch(() => setDetail(null));
  }, [params.poId]);

  useEffect(() => {
    load();
    fetch("/api/products")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setProducts(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [load]);

  const resolveLine = async (lineId: string, productId: string | null) => {
    setError(null);
    const res = await fetch(`/api/intake/pos/${params.poId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineId, productId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error ?? "Could not update this line.");
      return;
    }
    load();
  };

  const saveShipping = async () => {
    const value = Number(shippingInput);
    if (!Number.isFinite(value) || value < 0) {
      setError("Shipping cost must be a non-negative number.");
      return;
    }
    setSavingShipping(true);
    setError(null);
    const res = await fetch(`/api/intake/pos/${params.poId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shippingCost: value }),
    });
    setSavingShipping(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error ?? "Could not save shipping cost.");
      return;
    }
    load();
  };

  const reviewClose = async () => {
    if (!detail) return;
    const unmatched = detail.lines.filter((l) => !l.productId).length;
    const msg =
      unmatched > 0
        ? `${unmatched} product${unmatched === 1 ? "" : "s"} still need review. Close this PO anyway? Closed POs are read-only.`
        : "Close this PO? Closed POs are read-only.";
    if (!window.confirm(msg)) return;
    const res = await fetch(`/api/intake/pos/${params.poId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    if (res.ok) load();
  };

  const productById = new Map(products.map((p) => [p.id, p]));

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1400px] px-6 py-6">
        {detail === undefined ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <p className="animate-pulse text-ld-muted">Loading purchase order…</p>
          </div>
        ) : detail === null ? (
          <div className="glass-panel rounded-2xl p-10 text-center text-ld-muted">Purchase order not found.</div>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="mb-1 flex items-center gap-3">
                  <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
                    {detail.po.poNumber}
                  </h1>
                  <POStatusBadge status={detail.po.status} />
                </div>
                <p className="text-sm text-ld-muted">
                  {detail.po.supplierName} · Invoiced {formatDate(detail.po.invoiceDate)} · {detail.po.currency}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {detail.document && (
                  <a href={detail.document.blobUrl} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="md">
                      View Invoice PDF
                    </Button>
                  </a>
                )}
                {detail.po.status !== "closed" && (
                  <>
                    <Link href={`/intake/${params.poId}/receive`}>
                      <Button variant="primary" size="md">
                        Receive Inventory
                      </Button>
                    </Link>
                    <Button variant="ghost" size="md" onClick={reviewClose}>
                      Review / Close PO
                    </Button>
                  </>
                )}
              </div>
            </div>

            {error && (
              <div className="glass-panel mb-6 rounded-xl border border-ld-red/30 p-4 text-sm text-ld-red">{error}</div>
            )}

            <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Line Items" value={String(detail.po.lineCount)} />
              <Stat
                label="Units Received"
                value={`${detail.po.totalReceivedQty} / ${detail.po.totalExpectedQty}`}
              />
              <Stat label="PO Subtotal" value={formatCurrency(detail.po.subtotal)} accent="text-ld-amber" />
              <Stat label="Created" value={formatDate(detail.po.createdAt)} />
            </div>

            <FreightSummary
              po={detail.po}
              shippingInput={shippingInput}
              setShippingInput={setShippingInput}
              onSave={saveShipping}
              saving={savingShipping}
            />

            <div className="glass-panel rounded-2xl p-5">
              <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Line Items</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1100px] border-separate border-spacing-y-2 text-sm">
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-widest text-ld-muted">
                      <th className="px-3 pb-1">Description</th>
                      <th className="px-3 pb-1">Expected</th>
                      <th className="px-3 pb-1">Received</th>
                      <th className="px-3 pb-1">Purchase Cost</th>
                      <th className="px-3 pb-1">Landed Cost</th>
                      <th className="px-3 pb-1">Status</th>
                      <th className="px-3 pb-1">Product</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => {
                      const product = line.productId ? productById.get(line.productId) : undefined;
                      const freightPerUnit = detail.po.totalExpectedQty > 0 ? detail.po.shippingCost / detail.po.totalExpectedQty : 0;
                      return (
                        <tr key={line.id} className="rounded-xl bg-ld-bg-elevated align-top">
                          <td className="rounded-l-xl px-3 py-3">
                            <p className="font-medium text-ld-white">{line.rawDescription || "—"}</p>
                            <p className="text-xs text-ld-muted">{line.upc}</p>
                          </td>
                          <td className="px-3 py-3 text-ld-muted">{line.expectedQty}</td>
                          <td className="px-3 py-3 text-ld-white">{line.receivedQty}</td>
                          <td className="px-3 py-3 text-ld-amber">{formatCurrency(line.unitCost)}</td>
                          <td className="px-3 py-3 text-ld-amber">{formatCurrency(line.unitCost + freightPerUnit)}</td>
                          <td className="px-3 py-3">
                            <LineStatusBadge status={line.status} />
                          </td>
                          <td className="rounded-r-xl px-3 py-3">
                            {product ? (
                              <p className="text-ld-white">
                                {product.sku} — {product.brand} {product.name}
                              </p>
                            ) : (
                              <div className="flex items-center gap-2">
                                <MatchBadge type="unmatched" />
                                <select
                                  defaultValue=""
                                  onChange={(e) => resolveLine(line.id, e.target.value || null)}
                                  className="rounded-lg border border-ld-border bg-ld-bg px-2 py-1 text-xs text-ld-white outline-none focus:border-ld-purple"
                                >
                                  <option value="">Match to product…</option>
                                  {products.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.sku} — {p.brand} {p.name} ({p.size})
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function FreightSummary({
  po,
  shippingInput,
  setShippingInput,
  onSave,
  saving,
}: {
  po: PurchaseOrder;
  shippingInput: string;
  setShippingInput: (v: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const freightPerUnit = po.totalExpectedQty > 0 ? po.shippingCost / po.totalExpectedQty : 0;
  const totalLanded = po.subtotal + po.shippingCost;

  return (
    <div className="glass-panel mb-6 rounded-2xl p-5">
      <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Shipping / Freight</h2>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">
            Shipping / Freight Cost
          </label>
          <input
            type="number"
            step="0.01"
            value={shippingInput}
            onChange={(e) => setShippingInput(e.target.value)}
            disabled={po.status === "closed"}
            className="w-40 rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-ld-white outline-none focus:border-ld-purple disabled:opacity-50"
          />
        </div>
        {po.status !== "closed" && (
          <Button variant="outline" size="md" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Merchandise Cost" value={formatCurrency(po.subtotal)} />
        <Stat label="Freight" value={formatCurrency(po.shippingCost)} accent="text-ld-amber" />
        <Stat label="Total Units Ordered" value={String(po.totalExpectedQty)} />
        <Stat label="Freight / Unit" value={formatCurrency(freightPerUnit)} accent="text-ld-amber" />
        <Stat label="Total Landed PO Cost" value={formatCurrency(totalLanded)} accent="text-ld-purple" />
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="glass-panel rounded-xl p-4">
      <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${accent ?? "text-ld-white"}`}>{value}</p>
    </div>
  );
}
