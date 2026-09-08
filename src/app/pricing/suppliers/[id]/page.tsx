"use client";

import { useEffect, useRef, useState, use } from "react";
import { upload } from "@vercel/blob/client";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import type { Supplier, SupplierColumnMapping } from "@/lib/intake-types";
import type { SupplierPriceUpload } from "@/lib/pricing-types";

type Stage = "idle" | "uploading" | "mapping" | "processing" | "done";

const FIELD_LABELS: [keyof SupplierColumnMapping["columnMap"], string][] = [
  ["supplierSku", "Supplier SKU"],
  ["description", "Description"],
  ["brand", "Brand"],
  ["quantity", "Quantity / Stock"],
  ["price", "Price"],
  ["currency", "Currency"],
  ["upc", "UPC"],
  ["ean", "EAN"],
  ["category", "Category"],
];

export default function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const inputRef = useRef<HTMLInputElement>(null);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [uploads, setUploads] = useState<SupplierPriceUpload[]>([]);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [columnMap, setColumnMap] = useState<SupplierColumnMapping["columnMap"]>({});
  const [mappingReused, setMappingReused] = useState(false);
  const [uploadType, setUploadType] = useState<"full" | "partial">("full");
  const [result, setResult] = useState<SupplierPriceUpload | null>(null);

  const load = () => {
    fetch(`/api/pricing/suppliers/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setSupplier(data.supplier);
          setUploads(data.uploads ?? []);
        }
      })
      .catch(() => {});
  };

  useEffect(load, [id]);

  const handleFile = async (file: File) => {
    setError(null);
    setStage("uploading");
    setFilename(file.name);
    try {
      const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/pricing/upload" });
      setBlobUrl(blob.url);

      const res = await fetch("/api/pricing/parse-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: id, blobUrl: blob.url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not read this file.");

      setHeaders(data.headers);
      setRowCount(data.rowCount);
      setUploadType(data.defaultUploadType ?? "full");
      setMappingReused(Boolean(data.mappingReused));
      setColumnMap(data.mappingReused ? data.columnMap : data.suggestedColumnMap);
      setStage("mapping");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStage("idle");
    }
  };

  const submitProcess = async () => {
    if (!blobUrl) return;
    setStage("processing");
    setError(null);
    try {
      const res = await fetch("/api/pricing/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: id, blobUrl, filename, uploadType, columnMap }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not process this upload.");
      setResult(data);
      setStage("done");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStage("mapping");
    }
  };

  const reset = () => {
    setStage("idle");
    setBlobUrl(null);
    setHeaders([]);
    setColumnMap({});
    setResult(null);
    setError(null);
  };

  if (!supplier) {
    return (
      <div className="min-h-screen">
        <Nav />
        <main className="mx-auto max-w-[1000px] px-6 py-6 text-ld-muted">Loading…</main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1000px] px-6 py-6">
        <h1 className="mb-1 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">{supplier.name}</h1>
        <p className="mb-6 text-sm text-ld-muted">
          {[supplier.country, supplier.defaultCurrency, supplier.orderingMethod].filter(Boolean).join(" · ") || "No profile details yet"}
        </p>

        {error && <div className="glass-panel mb-6 rounded-xl border border-ld-red/30 p-4 text-sm text-ld-red">{error}</div>}

        <div className="glass-panel mb-6 rounded-2xl p-5">
          <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Upload Price List</h2>

          {stage === "idle" && (
            <div className="text-center">
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                  e.target.value = "";
                }}
              />
              <p className="mb-4 text-sm text-ld-muted">Upload this supplier&apos;s Excel or CSV price list.</p>
              <Button variant="primary" size="lg" onClick={() => inputRef.current?.click()}>
                Choose File
              </Button>
            </div>
          )}

          {stage === "uploading" && <p className="animate-pulse text-sm text-ld-muted">Uploading &amp; reading file…</p>}

          {stage === "mapping" && (
            <div className="space-y-5">
              <p className="text-sm text-ld-muted">
                {rowCount} data row{rowCount === 1 ? "" : "s"} found.{" "}
                {mappingReused ? (
                  <span className="font-semibold text-ld-green">Using the remembered column layout for this supplier.</span>
                ) : (
                  <span className="font-semibold text-ld-amber">
                    New or changed layout — confirm which column is which (this will be remembered for next time).
                  </span>
                )}
              </p>

              <div>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-ld-muted">Upload Type</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setUploadType("full")}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold ${uploadType === "full" ? "bg-ld-purple text-ld-white" : "bg-ld-bg-elevated text-ld-muted"}`}
                  >
                    Full Price List (replaces previous)
                  </button>
                  <button
                    onClick={() => setUploadType("partial")}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold ${uploadType === "partial" ? "bg-ld-purple text-ld-white" : "bg-ld-bg-elevated text-ld-muted"}`}
                  >
                    Partial / Update Only
                  </button>
                </div>
                {uploadType === "full" && (
                  <p className="mt-1.5 text-xs text-ld-muted">
                    Any previously-listed product from this supplier missing from this file will be marked &ldquo;No Longer
                    Listed&rdquo; (its history is kept).
                  </p>
                )}
              </div>

              {!mappingReused && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {FIELD_LABELS.map(([field, label]) => (
                    <div key={field}>
                      <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</label>
                      <select
                        value={columnMap[field] ?? ""}
                        onChange={(e) =>
                          setColumnMap((prev) => ({ ...prev, [field]: e.target.value === "" ? undefined : Number(e.target.value) }))
                        }
                        className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-2 py-1.5 text-xs text-ld-white outline-none focus:border-ld-purple"
                      >
                        <option value="">— None —</option>
                        {headers.map((h, i) => (
                          <option key={i} value={i}>
                            {h || `Column ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={reset}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={submitProcess} disabled={!columnMap.description && !columnMap.supplierSku}>
                  Process {rowCount} Row{rowCount === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          )}

          {stage === "processing" && <p className="animate-pulse text-sm text-ld-muted">Matching against the catalog…</p>}

          {stage === "done" && result && (
            <div className="space-y-3">
              <p className="text-sm text-ld-white">
                Processed <span className="font-semibold">{result.totalRows}</span> rows —{" "}
                <span className="font-semibold text-ld-green">{result.autoMatched} auto-matched</span>,{" "}
                <span className="font-semibold text-ld-amber">{result.needsReview} need review</span>,{" "}
                <span className="font-semibold text-ld-cyan">{result.newCandidates} new candidates</span>.
              </p>
              <Button variant="outline" onClick={reset}>
                Upload Another File
              </Button>
            </div>
          )}
        </div>

        <div className="glass-panel rounded-2xl p-5">
          <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Upload History</h2>
          {uploads.length === 0 ? (
            <p className="text-sm text-ld-muted">No uploads yet.</p>
          ) : (
            <div className="space-y-2">
              {uploads.map((u) => (
                <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ld-bg-elevated px-4 py-3 text-sm">
                  <span className="text-ld-white">{u.filename}</span>
                  <span className="text-xs text-ld-muted">
                    {u.uploadType} · {new Date(u.startedAt).toLocaleString()} ·{" "}
                    <span className={u.status === "failed" ? "text-ld-red" : "text-ld-green"}>{u.status}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
