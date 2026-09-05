"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { Overlay } from "@/components/Overlay";
import { ReceivingScanner } from "@/components/intake/ReceivingScanner";
import { LineStatusBadge } from "@/components/intake/IntakeBadges";
import { formatCurrency } from "@/lib/format";
import { computePOReviewSummary } from "@/lib/intake-review";
import type { POReviewSummary } from "@/lib/intake-review";
import type {
  InventoryLotWithRemaining,
  PurchaseOrder,
  PurchaseOrderLine,
  ReceiveMethod,
  ScanResolution,
} from "@/lib/intake-types";
import type { Product } from "@/lib/types";

const NOT_RECEIVED_REASONS = ["Missing", "Backordered", "Damaged", "Wrong Item", "Other"];
const OPERATOR_STORAGE_KEY = "amoruh_intake_operator";

interface Detail {
  po: PurchaseOrder;
  lines: PurchaseOrderLine[];
}

type DialogState =
  | { mode: "confirm"; line: PurchaseOrderLine; method: ReceiveMethod; duplicate?: boolean }
  | { mode: "unexpected"; productId: string; code: string }
  | { mode: "receiveAll" }
  | null;

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `idem_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default function ReceivePage() {
  const params = useParams<{ poId: string }>();
  const poId = params.poId;

  const [detail, setDetail] = useState<Detail | null | undefined>(undefined);
  const [products, setProducts] = useState<Product[]>([]);
  const [operator, setOperator] = useState(() =>
    typeof window !== "undefined" ? window.localStorage.getItem(OPERATOR_STORAGE_KEY) ?? "" : ""
  );
  const [dialog, setDialog] = useState<DialogState>(null);
  const [locationPrompt, setLocationPrompt] = useState<{ productId: string; currentShelf: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const saveOperator = (name: string) => {
    setOperator(name);
    window.localStorage.setItem(OPERATOR_STORAGE_KEY, name);
  };

  const load = useCallback(() => {
    Promise.all([
      fetch(`/api/intake/pos/${poId}`).then((res) => (res.ok ? res.json() : null)),
      fetch("/api/products").then((res) => (res.ok ? res.json() : [])),
    ]).then(([poData, productsData]) => {
      setDetail(poData ? { po: poData.po, lines: poData.lines } : null);
      setProducts(Array.isArray(productsData) ? productsData : []);
    });
  }, [poId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const existingProductIds = useMemo(() => new Set(products.map((p) => p.id)), [products]);

  const remainingLines = useMemo(
    () => detail?.lines.filter((l) => l.expectedQty - l.receivedQty > 0) ?? [],
    [detail]
  );
  const reviewSummary = useMemo(
    () => computePOReviewSummary(detail?.lines ?? [], existingProductIds),
    [detail, existingProductIds]
  );

  const handleScanResolved = (resolution: ScanResolution, code: string) => {
    setError(null);
    if (resolution.status === "unknown") {
      setError(`"${code}" doesn't match any product in AMORUH.`);
      return;
    }
    if (resolution.status === "unexpected" && resolution.productId) {
      setDialog({ mode: "unexpected", productId: resolution.productId, code });
      return;
    }
    if (resolution.line) {
      setDialog({ mode: "confirm", line: resolution.line, method: "barcode", duplicate: resolution.status === "duplicate" });
    }
  };

  const afterSuccess = (productId: string | null, message: string) => {
    setDialog(null);
    setToast(message);
    load();
    if (productId) {
      const product = productById.get(productId);
      setLocationPrompt({ productId, currentShelf: product?.shelf ?? "" });
    }
  };

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1200px] px-6 py-6">
        {detail === undefined ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <p className="animate-pulse text-ld-muted">Loading…</p>
          </div>
        ) : detail === null ? (
          <div className="glass-panel rounded-2xl p-10 text-center text-ld-muted">Purchase order not found.</div>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
                  Receiving — {detail.po.poNumber}
                </h1>
                <p className="text-sm text-ld-muted">{detail.po.supplierName}</p>
              </div>
              <div className="flex items-center gap-2">
                <Link href={`/intake/${poId}`}>
                  <Button variant="ghost" size="md">
                    ← Pause Receiving
                  </Button>
                </Link>
                <Button variant="primary" size="md" onClick={() => setDialog({ mode: "receiveAll" })}>
                  Receive All Remaining
                </Button>
              </div>
            </div>

            <ProgressBar po={detail.po} lines={detail.lines} />

            <div className="glass-panel mb-6 rounded-2xl p-5">
              <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">
                Operator
              </label>
              <input
                value={operator}
                onChange={(e) => saveOperator(e.target.value)}
                placeholder="Your name"
                className="mb-4 w-full max-w-xs rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
              />
              <ReceivingScanner poId={poId} onResolved={handleScanResolved} />
              {error && <p className="mt-2 text-sm font-semibold text-ld-red">{error}</p>}
            </div>

            <div className="glass-panel rounded-2xl p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-lg font-bold text-ld-white">
                  Line Items — {remainingLines.length} remaining
                </h2>
                <p className="text-sm text-ld-muted">
                  {reviewSummary.total} total ·{" "}
                  <span className="font-semibold text-ld-green">{reviewSummary.confirmed} confirmed</span>
                  {reviewSummary.unresolvedLineIds.length > 0 && (
                    <>
                      {" "}
                      · <span className="font-semibold text-ld-red">{reviewSummary.unresolvedLineIds.length} require review</span>
                    </>
                  )}
                </p>
              </div>
              <div className="space-y-2">
                {detail.lines.map((line) => {
                  const product = line.productId ? productById.get(line.productId) : undefined;
                  const remaining = Math.max(0, line.expectedQty - line.receivedQty);
                  return (
                    <div
                      key={line.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ld-bg-elevated px-4 py-3"
                    >
                      <div>
                        <p className="font-medium text-ld-white">
                          {product ? `${product.brand} ${product.name}` : line.rawDescription}
                        </p>
                        <p className="text-xs text-ld-muted">
                          Expected {line.expectedQty} · Received {line.receivedQty} · Remaining {remaining}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <LineStatusBadge status={line.status} />
                        {!product ? (
                          <span className="text-xs font-semibold text-ld-amber">Needs product match</span>
                        ) : (
                          <Button
                            variant="outline"
                            size="md"
                            disabled={remaining <= 0 && line.receivedQty === 0}
                            onClick={() =>
                              setDialog({
                                mode: "confirm",
                                line,
                                method: "manual",
                                duplicate: remaining <= 0 && line.receivedQty > 0,
                              })
                            }
                          >
                            Confirm Received
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </main>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-ld-green/15 px-5 py-3 text-sm font-semibold text-ld-green ring-1 ring-inset ring-ld-green/40">
          {toast}
        </div>
      )}

      {dialog?.mode === "confirm" && detail && (
        <ConfirmReceiveDialog
          po={detail.po}
          line={dialog.line}
          method={dialog.method}
          duplicate={dialog.duplicate}
          product={dialog.line.productId ? productById.get(dialog.line.productId) ?? null : null}
          operator={operator}
          onClose={() => setDialog(null)}
          onSuccess={afterSuccess}
        />
      )}

      {dialog?.mode === "unexpected" && (
        <UnexpectedItemDialog
          poId={poId}
          productId={dialog.productId}
          code={dialog.code}
          product={productById.get(dialog.productId) ?? null}
          method="barcode"
          operator={operator}
          onClose={() => setDialog(null)}
          onSuccess={afterSuccess}
        />
      )}

      {dialog?.mode === "receiveAll" && detail && (
        <ReceiveAllDialog
          poId={poId}
          remainingLines={remainingLines}
          reviewSummary={reviewSummary}
          operator={operator}
          onClose={() => setDialog(null)}
          onSuccess={(message) => {
            setDialog(null);
            setToast(message);
            load();
          }}
        />
      )}

      {locationPrompt && (
        <LocationPromptDialog
          productId={locationPrompt.productId}
          currentShelf={locationPrompt.currentShelf}
          onClose={() => setLocationPrompt(null)}
          onSaved={() => {
            setLocationPrompt(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Progress header (§17)
// ---------------------------------------------------------------------

function ProgressBar({ po, lines }: { po: PurchaseOrder; lines: PurchaseOrderLine[] }) {
  const complete = lines.filter((l) => l.status === "received" || l.status === "overage").length;
  const short = lines.reduce((s, l) => s + Math.max(0, l.expectedQty - l.receivedQty > 0 && l.receivedQty > 0 ? l.expectedQty - l.receivedQty : 0), 0);
  const overage = lines.reduce((s, l) => s + Math.max(0, l.receivedQty - l.expectedQty), 0);
  const freightPerUnit = po.totalExpectedQty > 0 ? po.shippingCost / po.totalExpectedQty : 0;

  return (
    <div className="glass-panel mb-6 grid grid-cols-2 gap-4 rounded-2xl p-5 sm:grid-cols-4 lg:grid-cols-7">
      <Stat label="SKU Lines" value={`${complete} / ${lines.length}`} />
      <Stat label="Units Ordered" value={String(po.totalExpectedQty)} />
      <Stat label="Units Received" value={String(po.totalReceivedQty)} accent="text-ld-green" />
      <Stat label="Units Remaining" value={String(Math.max(0, po.totalExpectedQty - po.totalReceivedQty))} />
      <Stat label="Short" value={String(short)} accent={short > 0 ? "text-ld-amber" : undefined} />
      <Stat label="Overage" value={String(overage)} accent={overage > 0 ? "text-ld-purple" : undefined} />
      <Stat label="Freight / Unit" value={formatCurrency(freightPerUnit)} accent="text-ld-amber" />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${accent ?? "text-ld-white"}`}>{value}</p>
    </div>
  );
}


// ---------------------------------------------------------------------
// Confirm Received (§1, §2, §3, §4, §5, §13)
// ---------------------------------------------------------------------

function ConfirmReceiveDialog({
  po,
  line,
  method,
  duplicate,
  product,
  operator,
  onClose,
  onSuccess,
}: {
  po: PurchaseOrder;
  line: PurchaseOrderLine;
  method: ReceiveMethod;
  duplicate?: boolean;
  product: Product | null;
  operator: string;
  onClose: () => void;
  onSuccess: (productId: string | null, message: string) => void;
}) {
  const [lots, setLots] = useState<InventoryLotWithRemaining[]>([]);
  const [step, setStep] = useState<"choose" | "modify" | "not_received" | "overage">(
    duplicate ? "overage" : "choose"
  );
  const [modifyQty, setModifyQty] = useState("");
  const [reason, setReason] = useState(NOT_RECEIVED_REASONS[0]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey());

  useEffect(() => {
    if (!product) return;
    fetch(`/api/intake/products/${product.id}/lots`)
      .then((res) => (res.ok ? res.json() : { lots: [] }))
      .then((data) => setLots(data.lots ?? []))
      .catch(() => {});
  }, [product]);

  const remaining = Math.max(0, line.expectedQty - line.receivedQty);
  const otherLots = lots.filter((l) => l.poId !== po.id && l.remaining > 0);
  const landedCost = po.totalExpectedQty > 0 ? line.unitCost + po.shippingCost / po.totalExpectedQty : line.unitCost;

  const submit = async (type: "received" | "modify" | "not_received", actualQty?: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/intake/pos/${po.id}/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poLineId: line.id,
          type,
          actualQty,
          reason: type === "not_received" ? reason : undefined,
          notes,
          method,
          operator,
          idempotencyKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not record this action.");
      const messages: Record<string, string> = {
        received: `Received ${data.event.actualQty} — inventory updated.`,
        modify: `Received ${data.event.actualQty} — inventory updated.`,
        not_received: "Marked not received.",
      };
      onSuccess(line.productId, messages[type] ?? "Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay>
      {duplicate && step === "overage" ? (
        <>
          <h2 className="mb-2 font-display text-lg font-bold text-ld-red">Already Fully Received</h2>
          <p className="mb-5 text-sm text-ld-muted">
            This item has already been fully received on {po.poNumber}. Scanning it again won&apos;t automatically
            add more inventory.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" size="md" onClick={() => setStep("modify")}>
              Add Deliberate Overage
            </Button>
          </div>
        </>
      ) : (
        <>
          <h2 className="mb-1 font-display text-lg font-bold text-ld-white">
            {product ? `${product.brand} ${product.name}` : line.rawDescription}
          </h2>
          <p className="mb-4 text-sm text-ld-muted">
            {product?.size} · UPC {line.upc || "—"} · {po.poNumber}
          </p>

          <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl border border-ld-border bg-ld-bg-elevated p-4 text-sm sm:grid-cols-3">
            <Field label="Expected Qty" value={String(line.expectedQty)} />
            <Field label="Previously Received" value={String(line.receivedQty)} />
            <Field label="Remaining Expected" value={String(remaining)} />
            <Field label="Purchase Cost" value={formatCurrency(line.unitCost)} accent="text-ld-amber" />
            {po.shippingCost > 0 && <Field label="Landed Cost" value={formatCurrency(landedCost)} accent="text-ld-amber" />}
            {product && <Field label="Existing Inventory" value={String(product.inventory)} />}
          </div>

          {otherLots.length > 0 && (
            <div className="mb-4 rounded-xl border border-ld-border p-3 text-xs text-ld-muted">
              <p className="mb-1 font-bold uppercase tracking-widest">Existing Cost Layers</p>
              {otherLots.map((lot) => (
                <p key={lot.id}>
                  {lot.poNumber} — {lot.remaining} remaining @ {formatCurrency(lot.cost.landed)}
                </p>
              ))}
            </div>
          )}

          {error && <p className="mb-3 text-sm font-semibold text-ld-red">{error}</p>}

          {step === "choose" && (
            <div className="grid grid-cols-3 gap-2">
              <Button variant="primary" size="lg" disabled={busy} onClick={() => submit("received")}>
                YES
              </Button>
              <Button variant="outline" size="lg" disabled={busy} onClick={() => setStep("modify")}>
                MODIFY
              </Button>
              <Button variant="danger" size="lg" disabled={busy} onClick={() => setStep("not_received")}>
                NO
              </Button>
            </div>
          )}

          {step === "modify" && (
            <div className="space-y-3">
              <label className="block text-xs font-bold uppercase tracking-widest text-ld-muted">
                How many units physically arrived in this shipment?
              </label>
              <input
                type="number"
                value={modifyQty}
                onChange={(e) => setModifyQty(e.target.value)}
                autoFocus
                className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-ld-white outline-none focus:border-ld-purple"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="md" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  disabled={busy || !modifyQty}
                  onClick={() => submit("modify", Number(modifyQty))}
                >
                  Save
                </Button>
              </div>
            </div>
          )}

          {step === "not_received" && (
            <div className="space-y-3">
              <label className="block text-xs font-bold uppercase tracking-widest text-ld-muted">Reason</label>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-ld-white outline-none focus:border-ld-purple"
              >
                {NOT_RECEIVED_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (optional)"
                rows={2}
                className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="md" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="danger" size="md" disabled={busy} onClick={() => submit("not_received")}>
                  Confirm Not Received
                </Button>
              </div>
            </div>
          )}

          {step === "choose" && (
            <button onClick={onClose} className="mt-3 text-xs text-ld-muted hover:text-ld-white">
              Cancel
            </button>
          )}
        </>
      )}
    </Overlay>
  );
}

function Field({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <p className={`font-semibold ${accent ?? "text-ld-white"}`}>{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------
// Unexpected item (§14)
// ---------------------------------------------------------------------

function UnexpectedItemDialog({
  poId,
  productId,
  code,
  product,
  method,
  operator,
  onClose,
  onSuccess,
}: {
  poId: string;
  productId: string;
  code: string;
  product: Product | null;
  method: ReceiveMethod;
  operator: string;
  onClose: () => void;
  onSuccess: (productId: string | null, message: string) => void;
}) {
  const [quantity, setQuantity] = useState("1");
  const [cost, setCost] = useState(product ? String(product.cost) : "0");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey());

  const submit = async () => {
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/intake/pos/${poId}/receive-unexpected`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          quantity: Number(quantity),
          cost: Number(cost),
          reason,
          method,
          operator,
          idempotencyKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not record this item.");
      onSuccess(productId, `Recorded ${data.event.actualQty} unexpected units.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay>
      <h2 className="mb-2 font-display text-lg font-bold text-ld-amber">Product Not Expected On This PO</h2>
      <p className="mb-4 text-sm text-ld-muted">
        {product ? `${product.brand} ${product.name}` : code} matched a product in AMORUH, but it isn&apos;t on this
        purchase order.
      </p>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-bold uppercase tracking-widest text-ld-muted">Quantity</label>
          <input
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-ld-white outline-none focus:border-ld-purple"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold uppercase tracking-widest text-ld-muted">Unit Cost</label>
          <input
            type="number"
            step="0.01"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-ld-white outline-none focus:border-ld-purple"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold uppercase tracking-widest text-ld-muted">Reason</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Supplier included extra units"
            className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-ld-white outline-none focus:border-ld-purple"
          />
        </div>
      </div>

      {error && <p className="mt-3 text-sm font-semibold text-ld-red">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="md" disabled={busy} onClick={submit}>
          Add Unexpected Item
        </Button>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------
// Receive All (§6)
// ---------------------------------------------------------------------

function ReceiveAllDialog({
  poId,
  remainingLines,
  reviewSummary,
  operator,
  onClose,
  onSuccess,
}: {
  poId: string;
  remainingLines: PurchaseOrderLine[];
  reviewSummary: POReviewSummary;
  operator: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey());

  const remainingUnits = remainingLines.reduce((s, l) => s + (l.expectedQty - l.receivedQty), 0);
  const unresolvedCount = reviewSummary.unresolvedLineIds.length;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/intake/pos/${poId}/receive-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator, idempotencyKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not receive all remaining inventory.");
      onSuccess(`Received ${data.unitsReceived} units across ${data.linesReceived} lines.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay>
      <h2 className="mb-2 font-display text-lg font-bold text-ld-white">Receive All Remaining Inventory?</h2>
      <p className="mb-4 text-sm text-ld-muted">
        Remaining SKUs: <span className="font-semibold text-ld-white">{remainingLines.length}</span> · Remaining
        Units: <span className="font-semibold text-ld-white">{remainingUnits}</span>
      </p>
      <p className="mb-4 text-sm text-ld-muted">
        This will receive all remaining expected quantities, add them to inventory, create the proper transaction
        and cost-layer records, apply this PO&apos;s freight allocation, and mark the applicable lines received.
      </p>

      <div className="mb-4 grid grid-cols-3 gap-3 rounded-xl border border-ld-border bg-ld-bg-elevated p-3 text-center text-sm">
        <div>
          <p className="text-lg font-bold text-ld-white">{reviewSummary.total}</p>
          <p className="text-[11px] uppercase tracking-widest text-ld-muted">Total Products</p>
        </div>
        <div>
          <p className="text-lg font-bold text-ld-green">{reviewSummary.confirmed}</p>
          <p className="text-[11px] uppercase tracking-widest text-ld-muted">Confirmed</p>
        </div>
        <div>
          <p className={`text-lg font-bold ${unresolvedCount > 0 ? "text-ld-red" : "text-ld-green"}`}>{unresolvedCount}</p>
          <p className="text-[11px] uppercase tracking-widest text-ld-muted">Require Review</p>
        </div>
      </div>

      {unresolvedCount > 0 && (
        <Link href={`/intake/${poId}`}>
          <Button variant="outline" size="md" fullWidth className="mb-4">
            Review {unresolvedCount} Product{unresolvedCount === 1 ? "" : "s"}
          </Button>
        </Link>
      )}
      {error && <p className="mb-4 text-sm font-semibold text-ld-red">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="md" disabled={busy || unresolvedCount > 0} onClick={submit}>
          Confirm Receive All
        </Button>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------
// Warehouse location confirm/assign (§16) — just Product.shelf
// ---------------------------------------------------------------------

function LocationPromptDialog({
  productId,
  currentShelf,
  onClose,
  onSaved,
}: {
  productId: string;
  currentShelf: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [shelf, setShelf] = useState(currentShelf);
  const [editing, setEditing] = useState(!currentShelf);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await fetch(`/api/products/${productId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shelf }),
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay>
      <h2 className="mb-3 font-display text-lg font-bold text-ld-white">Warehouse Location</h2>
      {!editing && currentShelf ? (
        <>
          <p className="mb-4 text-sm text-ld-muted">
            Location: <span className="font-semibold text-ld-white">{currentShelf}</span>
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="md" onClick={() => setEditing(true)}>
              Change
            </Button>
            <Button variant="primary" size="md" onClick={onClose}>
              Confirm
            </Button>
          </div>
        </>
      ) : (
        <>
          <input
            value={shelf}
            onChange={(e) => setShelf(e.target.value)}
            placeholder="e.g. B-1-03"
            autoFocus
            className="mb-4 w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-ld-white outline-none focus:border-ld-purple"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={onClose}>
              Skip
            </Button>
            <Button variant="primary" size="md" disabled={busy} onClick={save}>
              {currentShelf ? "Save" : "Assign Location"}
            </Button>
          </div>
        </>
      )}
    </Overlay>
  );
}
