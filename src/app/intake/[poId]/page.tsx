"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { POStatusBadge, LineStatusBadge, MatchBadge } from "@/components/intake/IntakeBadges";
import { CreateProductModal } from "@/components/intake/CreateProductModal";
import { formatCurrency, formatDate } from "@/lib/format";
import { computePOReviewSummary, isLineConfirmed } from "@/lib/intake-review";
import { matchLineItem } from "@/lib/intake-matching";
import type { InvoiceDocument, PurchaseOrder, PurchaseOrderLine } from "@/lib/intake-types";
import type { Product } from "@/lib/types";

interface BulkCreateResultSummary {
  created: number;
  failed: number;
  failedLineIds: string[];
}

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
  const [modalLineId, setModalLineId] = useState<string | null>(null);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkCreateResultSummary | null>(null);

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

  const runBulkCreate = async () => {
    setBulkCreating(true);
    setError(null);
    try {
      const res = await fetch(`/api/intake/pos/${params.poId}/bulk-create-products`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not create products.");
      type Result = { lineId: string; status: string; error?: string };
      const results: Result[] = data.results ?? [];
      const created = results.filter((r) => r.status === "created" || r.status === "linked_existing").length;
      const failed = results.filter((r) => r.status === "failed" || r.status === "needs_review");
      setBulkResult({ created, failed: failed.length, failedLineIds: failed.map((r) => r.lineId) });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create products.");
    } finally {
      setBulkCreating(false);
    }
  };

  const reviewClose = async () => {
    if (!detail) return;
    const existingProductIds = new Set(products.map((p) => p.id));
    const unmatched = computePOReviewSummary(detail.lines, existingProductIds).unresolvedLineIds.length;
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
  const existingProductIds = new Set(products.map((p) => p.id));
  const reviewSummary = detail ? computePOReviewSummary(detail.lines, existingProductIds) : null;

  // Three-way bucket, matching the Upload/Review screen: Matched Existing /
  // Possible Match — Review Required / New Product — Ready to Create.
  // A saved PO's persisted matchType collapses any never-confirmed line to
  // "unmatched" (the original fuzzy candidate isn't stored), so the fuzzy
  // check is re-run live here against today's catalog — this also doubles
  // as the safety check the bulk button needs (never bulk-create over a
  // line that now has a decent candidate).
  const unresolvedLines = detail ? detail.lines.filter((l) => !isLineConfirmed(l, existingProductIds)) : [];
  const liveFuzzyByLineId = new Map(
    unresolvedLines
      .map((l) => [
        l.id,
        matchLineItem(
          {
            rawDescription: l.rawDescription,
            upc: l.upc,
            brand: l.brand,
            name: l.name,
            size: l.size,
            concentration: l.concentration,
            quantity: l.expectedQty,
            unitCost: l.unitCost,
            lineTotal: l.lineTotal,
          },
          products
        ),
      ] as const)
      .filter(([, m]) => m.matchType === "fuzzy")
  );
  const reviewRequiredCount = liveFuzzyByLineId.size;
  const readyToCreateCount = unresolvedLines.length - reviewRequiredCount;

  const modalLine = detail?.lines.find((l) => l.id === modalLineId) ?? null;

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

            {reviewSummary && (
              <div className="mb-6">
                <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat label="Total Products" value={String(reviewSummary.total)} />
                  <Stat label="Matched Existing" value={String(reviewSummary.confirmed)} accent="text-ld-green" />
                  <Stat
                    label="Possible Match — Review"
                    value={String(reviewRequiredCount)}
                    accent={reviewRequiredCount > 0 ? "text-ld-amber" : undefined}
                  />
                  <Stat
                    label="Ready to Create"
                    value={String(readyToCreateCount)}
                    accent={readyToCreateCount > 0 ? "text-ld-cyan" : undefined}
                  />
                </div>
                {readyToCreateCount > 0 && detail.po.status !== "closed" && (
                  <Button variant="cyan" size="md" disabled={bulkCreating} onClick={runBulkCreate}>
                    {bulkCreating ? "Creating…" : `Create ${readyToCreateCount} New Product${readyToCreateCount === 1 ? "" : "s"}`}
                  </Button>
                )}
                {bulkResult && (
                  <p className="mt-2 text-sm">
                    <span className="font-semibold text-ld-green">{bulkResult.created} created and linked</span>
                    {bulkResult.failed > 0 && (
                      <>
                        {" · "}
                        <span className="font-semibold text-ld-red">{bulkResult.failed} failed</span>{" "}
                        <button onClick={runBulkCreate} className="font-bold text-ld-cyan hover:underline">
                          Retry {bulkResult.failed} Failed Item{bulkResult.failed === 1 ? "" : "s"}
                        </button>
                      </>
                    )}
                  </p>
                )}
              </div>
            )}

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
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  {liveFuzzyByLineId.has(line.id) ? (
                                    <MatchBadge type="fuzzy" confidence={liveFuzzyByLineId.get(line.id)!.candidate?.confidence} />
                                  ) : (
                                    <MatchBadge type="unmatched" />
                                  )}
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
                                {liveFuzzyByLineId.has(line.id) && (
                                  <button
                                    onClick={() => resolveLine(line.id, liveFuzzyByLineId.get(line.id)!.candidate!.productId)}
                                    className="block text-xs font-bold text-ld-purple hover:underline"
                                  >
                                    Use {liveFuzzyByLineId.get(line.id)!.candidate!.brand}{" "}
                                    {liveFuzzyByLineId.get(line.id)!.candidate!.name} (
                                    {liveFuzzyByLineId.get(line.id)!.candidate!.size})
                                  </button>
                                )}
                                <button
                                  onClick={() => setModalLineId(line.id)}
                                  className="block text-xs font-bold text-ld-cyan hover:underline"
                                >
                                  + Create New Product From Invoice
                                </button>
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

      {modalLine && (
        <CreateProductModal
          initialValues={{
            sku: modalLine.upc || "",
            barcode: modalLine.upc || "",
            brand: modalLine.brand,
            name: modalLine.name,
            size: modalLine.size,
            concentration: modalLine.concentration,
            description: modalLine.rawDescription,
            cost: modalLine.unitCost,
            status: "draft",
          }}
          createUrl={`/api/intake/pos/${params.poId}/lines/${modalLine.id}/create-product`}
          onCreated={() => {
            setModalLineId(null);
            load();
          }}
          onClose={() => setModalLineId(null)}
        />
      )}
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
