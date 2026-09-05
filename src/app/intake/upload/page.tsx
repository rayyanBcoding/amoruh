"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { MatchBadge } from "@/components/intake/IntakeBadges";
import { CreateProductModal } from "@/components/intake/CreateProductModal";
import { formatCurrency } from "@/lib/format";
import type { ExtractedPO, MatchedLineItem } from "@/lib/intake-types";
import type { Product } from "@/lib/types";

type Stage = "choose" | "uploading" | "parsing" | "review" | "saving";

export default function UploadInvoicePage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("choose");
  const [error, setError] = useState<string | null>(null);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [extracted, setExtracted] = useState<ExtractedPO | null>(null);
  const [lines, setLines] = useState<MatchedLineItem[]>([]);
  const [resolved, setResolved] = useState<(string | null)[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [modalLineIndex, setModalLineIndex] = useState<number | null>(null);
  const [bulkCreating, setBulkCreating] = useState(false);

  const loadProducts = () => {
    fetch("/api/products")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setProducts(Array.isArray(data) ? data : []))
      .catch(() => {});
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const handleFile = async (file: File) => {
    setError(null);
    if (file.type !== "application/pdf") {
      setError("Please choose a PDF invoice or purchase order.");
      return;
    }

    setStage("uploading");
    setFilename(file.name);
    try {
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/intake/upload",
      });
      setBlobUrl(blob.url);

      setStage("parsing");
      const res = await fetch("/api/intake/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blobUrl: blob.url, filename: file.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not parse this invoice.");

      setExtracted(data.extracted);
      setLines(data.matched);
      setResolved(
        (data.matched as MatchedLineItem[]).map((l) =>
          l.matchType === "upc" || l.matchType === "sku" ? l.candidate?.productId ?? null : null
        )
      );
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStage("choose");
    }
  };

  const acceptCandidate = (i: number) => {
    const candidateId = lines[i].candidate?.productId ?? null;
    setResolved((prev) => prev.map((v, idx) => (idx === i ? candidateId : v)));
  };

  const setLineQty = (i: number, qty: number) => {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, quantity: qty } : l)));
  };

  const setLineCost = (i: number, cost: number) => {
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, unitCost: cost, lineTotal: cost * l.quantity } : l))
    );
  };

  const updateHeader = (patch: Partial<ExtractedPO>) => {
    setExtracted((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const submit = async () => {
    if (!extracted || !blobUrl) return;
    setStage("saving");
    setError(null);
    try {
      const res = await fetch("/api/intake/pos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extracted, lines, resolvedProductIds: resolved, blobUrl, filename }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not create the purchase order.");
      router.push(`/intake/${data.po.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStage("review");
    }
  };

  // Three buckets, per the spec: Matched Existing / Possible Match —
  // Review Required / New Product — Ready to Create. matchType +
  // resolved[] already carry everything needed to partition every line;
  // nothing new is computed here beyond counting.
  const matchedCount = lines.filter((_, i) => resolved[i] !== null).length;
  const reviewCount = lines.filter((l, i) => l.matchType === "fuzzy" && resolved[i] === null).length;
  const readyIndices = lines
    .map((l, i) => i)
    .filter((i) => lines[i].matchType === "unmatched" && resolved[i] === null);
  const readyCount = readyIndices.length;

  const handleProductCreated = (i: number, product: Product) => {
    setResolved((prev) => prev.map((v, idx) => (idx === i ? product.id : v)));
    setProducts((prev) => [...prev, product]);
    setModalLineIndex(null);
  };

  const createAllReady = async () => {
    if (readyIndices.length === 0) return;
    setBulkCreating(true);
    setError(null);
    const specs = readyIndices.map((i) => {
      const l = lines[i];
      return {
        sku: l.upc || `NEW-${Date.now()}-${i}`,
        barcode: l.upc || undefined,
        brand: l.brand,
        name: l.name,
        size: l.size,
        concentration: l.concentration,
        description: l.rawDescription,
        cost: l.unitCost,
        status: "draft",
        inventory: 0,
      };
    });
    try {
      const res = await fetch("/api/products/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ products: specs }),
      });
      const data = await res.json();
      const results: { ok: boolean; product?: Product; error?: string }[] = data.results ?? [];
      setResolved((prev) => {
        const next = [...prev];
        results.forEach((r, j) => {
          if (r.ok && r.product) next[readyIndices[j]] = r.product.id;
        });
        return next;
      });
      setProducts((prev) => [...prev, ...results.filter((r) => r.ok && r.product).map((r) => r.product as Product)]);
      const failedCount = results.filter((r) => !r.ok).length;
      if (failedCount > 0) {
        setError(`${failedCount} product${failedCount === 1 ? "" : "s"} could not be created — check for a duplicate SKU/UPC.`);
      }
    } catch {
      setError("Could not create products — check your connection and try again.");
    } finally {
      setBulkCreating(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1400px] px-6 py-6">
        <h1 className="mb-6 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
          Upload Invoice / PO
        </h1>

        {error && (
          <div className="glass-panel mb-6 rounded-xl border border-ld-red/30 p-4 text-sm text-ld-red">{error}</div>
        )}

        {(stage === "choose" || stage === "uploading" || stage === "parsing") && (
          <div className="glass-panel rounded-2xl p-10 text-center">
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
            {stage === "choose" ? (
              <>
                <p className="mb-4 text-ld-muted">
                  Upload a supplier invoice or purchase order PDF. Claude will read it and extract line items —
                  you&apos;ll confirm everything before it&apos;s saved.
                </p>
                <Button variant="primary" size="lg" onClick={() => inputRef.current?.click()}>
                  Choose PDF
                </Button>
              </>
            ) : (
              <p className="animate-pulse text-lg font-semibold text-ld-muted">
                {stage === "uploading" ? "Uploading…" : "Reading the invoice with Claude…"}
              </p>
            )}
          </div>
        )}

        {(stage === "review" || stage === "saving") && extracted && (
          <div className="space-y-6">
            <div className="glass-panel grid grid-cols-1 gap-4 rounded-2xl p-5 sm:grid-cols-4">
              <Field label="PO / Invoice #" value={extracted.poNumber} onChange={(v) => updateHeader({ poNumber: v })} />
              <Field label="Supplier" value={extracted.supplierName} onChange={(v) => updateHeader({ supplierName: v })} />
              <Field label="Invoice Date" value={extracted.invoiceDate} onChange={(v) => updateHeader({ invoiceDate: v })} />
              <Field label="Currency" value={extracted.currency} onChange={(v) => updateHeader({ currency: v })} />
            </div>

            <div className="glass-panel rounded-2xl p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-lg font-bold text-ld-white">
                  {lines.length} Line Item{lines.length === 1 ? "" : "s"}
                </h2>
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span className="text-ld-muted">
                    <span className="font-semibold text-ld-green">{matchedCount} matched existing</span>
                    {" · "}
                    <span className={reviewCount > 0 ? "font-semibold text-ld-amber" : ""}>
                      {reviewCount} require review
                    </span>
                    {" · "}
                    <span className={readyCount > 0 ? "font-semibold text-ld-cyan" : ""}>
                      {readyCount} ready to create
                    </span>
                  </span>
                  {readyCount > 0 && (
                    <Button variant="cyan" size="md" disabled={bulkCreating} onClick={createAllReady}>
                      {bulkCreating ? "Creating…" : `Create ${readyCount} New Product${readyCount === 1 ? "" : "s"}`}
                    </Button>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[1100px] border-separate border-spacing-y-2 text-sm">
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-widest text-ld-muted">
                      <th className="px-3 pb-1">Invoice Description</th>
                      <th className="px-3 pb-1">UPC</th>
                      <th className="px-3 pb-1">Qty</th>
                      <th className="px-3 pb-1">Unit Cost</th>
                      <th className="px-3 pb-1">Line Total</th>
                      <th className="px-3 pb-1">Match</th>
                      <th className="px-3 pb-1">Product</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, i) => (
                      <tr key={i} className="rounded-xl bg-ld-bg-elevated align-top">
                        <td className="rounded-l-xl px-3 py-3">
                          <p className="font-medium text-ld-white">{line.rawDescription || "—"}</p>
                          <p className="text-xs text-ld-muted">
                            {[line.brand, line.name, line.size, line.concentration].filter(Boolean).join(" · ")}
                          </p>
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-ld-muted">{line.upc || "—"}</td>
                        <td className="px-3 py-3">
                          <input
                            type="number"
                            value={line.quantity}
                            onChange={(e) => setLineQty(i, Number(e.target.value))}
                            className="w-16 rounded-lg border border-ld-border bg-ld-bg px-2 py-1 text-ld-white outline-none focus:border-ld-purple"
                          />
                        </td>
                        <td className="px-3 py-3">
                          <input
                            type="number"
                            step="0.01"
                            value={line.unitCost}
                            onChange={(e) => setLineCost(i, Number(e.target.value))}
                            className="w-24 rounded-lg border border-ld-border bg-ld-bg px-2 py-1 text-ld-amber outline-none focus:border-ld-purple"
                          />
                        </td>
                        <td className="px-3 py-3 text-ld-muted">{formatCurrency(line.lineTotal)}</td>
                        <td className="px-3 py-3">
                          <MatchBadge type={line.matchType} confidence={line.candidate?.confidence} />
                          {line.matchType === "fuzzy" && line.candidate && !resolved[i] && (
                            <button
                              onClick={() => acceptCandidate(i)}
                              className="mt-1 block text-xs font-bold text-ld-purple hover:underline"
                            >
                              Use {line.candidate.brand} {line.candidate.name} ({line.candidate.size})
                            </button>
                          )}
                        </td>
                        <td className="rounded-r-xl px-3 py-3">
                          <select
                            value={resolved[i] ?? ""}
                            onChange={(e) =>
                              setResolved((prev) => prev.map((v, idx) => (idx === i ? e.target.value || null : v)))
                            }
                            className="w-56 rounded-lg border border-ld-border bg-ld-bg px-2 py-1.5 text-xs text-ld-white outline-none focus:border-ld-purple"
                          >
                            <option value="">— Unmatched —</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.sku} — {p.brand} {p.name} ({p.size})
                              </option>
                            ))}
                          </select>
                          {!resolved[i] && (
                            <div className="mt-1 flex items-center gap-2">
                              <button
                                onClick={() => setModalLineIndex(i)}
                                className="text-xs font-bold text-ld-cyan hover:underline"
                              >
                                + Create New Product From Invoice
                              </button>
                              <button onClick={loadProducts} className="text-xs text-ld-muted hover:text-ld-white">
                                ↻ Refresh
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-sm text-ld-muted">
                Unmatched lines can still be resolved later from the PO Detail page — this doesn&apos;t have to be
                perfect before saving.
              </p>
              <Button variant="primary" size="lg" disabled={stage === "saving"} onClick={submit}>
                {stage === "saving" ? "Creating PO…" : "Create Purchase Order"}
              </Button>
            </div>
          </div>
        )}
      </main>

      {modalLineIndex !== null && (
        <CreateProductModal
          initialValues={{
            sku: lines[modalLineIndex].upc || "",
            barcode: lines[modalLineIndex].upc || "",
            brand: lines[modalLineIndex].brand,
            name: lines[modalLineIndex].name,
            size: lines[modalLineIndex].size,
            concentration: lines[modalLineIndex].concentration,
            description: lines[modalLineIndex].rawDescription,
            cost: lines[modalLineIndex].unitCost,
            status: "draft",
          }}
          onCreated={(product) => handleProductCreated(modalLineIndex, product)}
          onClose={() => setModalLineIndex(null)}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
      />
    </div>
  );
}
