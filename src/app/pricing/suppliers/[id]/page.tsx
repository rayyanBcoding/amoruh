"use client";

import { useEffect, useRef, useState, use } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { ConfirmDangerAction } from "@/components/ConfirmDangerAction";
import type { Supplier, SupplierColumnMapping } from "@/lib/intake-types";
import type { SupplierPriceUpload, SupplierRawRow } from "@/lib/pricing-types";

const EDITABLE_FIELDS: [keyof Supplier, string, string?][] = [
  ["name", "Supplier Name"],
  ["contactPerson", "Contact Name"],
  ["email", "Email"],
  ["whatsapp", "Phone / WhatsApp"],
  ["website", "Website"],
  ["country", "Country"],
  ["defaultCurrency", "Currency"],
  ["notes", "Notes (also used for payment / ordering notes)"],
];

type Stage = "idle" | "uploading" | "mapping" | "preview" | "processing" | "done";

interface ColumnPreview {
  index: number;
  letter: string;
  header: string;
  samples: string[];
}

interface SanityCheck {
  ok: boolean;
  totalRows: number;
  priceValidRatio: number;
  descriptionValidRatio: number;
  warnings: string[];
}

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

function columnLabel(col: ColumnPreview | undefined): string {
  if (!col) return "";
  return `${col.letter} — ${col.header || "(blank)"}`;
}

export default function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [uploads, setUploads] = useState<SupplierPriceUpload[]>([]);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Supplier>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleteEligibility, setDeleteEligibility] = useState<{ eligible: boolean; reasons: string[] } | null>(null);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("");

  const [headerRowWindow, setHeaderRowWindow] = useState<string[][]>([]);
  const [detectedHeaderRowIndex, setDetectedHeaderRowIndex] = useState(0);
  const [headerRowIndex, setHeaderRowIndex] = useState(0);
  const [headerConfident, setHeaderConfident] = useState(true);
  const [headerSignature, setHeaderSignature] = useState<string[]>([]);
  const [columns, setColumns] = useState<ColumnPreview[]>([]);
  const [columnMap, setColumnMap] = useState<SupplierColumnMapping["columnMap"]>({});
  const [mappingReused, setMappingReused] = useState(false);
  const [previewRows, setPreviewRows] = useState<SupplierRawRow[]>([]);
  const [totalProductRows, setTotalProductRows] = useState(0);
  const [sanityCheck, setSanityCheck] = useState<SanityCheck | null>(null);
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
    fetch(`/api/pricing/suppliers/${id}/delete-eligibility`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setDeleteEligibility(data))
      .catch(() => {});
  };

  useEffect(load, [id]);

  const startEdit = () => {
    if (!supplier) return;
    setEditForm({
      name: supplier.name,
      contactPerson: supplier.contactPerson ?? "",
      email: supplier.email ?? "",
      whatsapp: supplier.whatsapp ?? "",
      website: supplier.website ?? "",
      country: supplier.country ?? "",
      defaultCurrency: supplier.defaultCurrency ?? "",
      notes: supplier.notes ?? "",
      orderingMethod: supplier.orderingMethod,
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    setError(null);
    try {
      const res = await fetch(`/api/pricing/suppliers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not save changes.");
      setSupplier(data);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes.");
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleArchive = async () => {
    if (!supplier) return;
    const nextStatus = supplier.status === "archived" ? "active" : "archived";
    setArchiving(true);
    setError(null);
    try {
      const res = await fetch(`/api/pricing/suppliers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not update status.");
      setSupplier(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update status.");
    } finally {
      setArchiving(false);
    }
  };

  const deleteSupplierPermanently = async () => {
    setError(null);
    const res = await fetch(`/api/pricing/suppliers/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error ?? "Could not delete this supplier.");
      if (data?.reasons) setDeleteEligibility({ eligible: false, reasons: data.reasons });
      return;
    }
    router.push("/pricing/suppliers");
  };

  const columnAt = (idx: number | undefined) => columns.find((c) => c.index === idx);

  // Re-fetches the full preview pass whenever the header row or column
  // map changes, so what's shown is never stale relative to the current
  // selection. Never writes anything.
  const refreshPreview = async (overrides: { headerRowIndex?: number; columnMap?: SupplierColumnMapping["columnMap"] }) => {
    if (!blobUrl) return;
    setLoadingPreview(true);
    setError(null);
    try {
      const res = await fetch("/api/pricing/parse-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: id, blobUrl, ...overrides }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not read this file.");

      setHeaderRowWindow(data.headerRowWindow);
      setDetectedHeaderRowIndex(data.detectedHeaderRowIndex);
      setHeaderRowIndex(data.headerRowIndex);
      setHeaderConfident(data.headerConfident);
      setHeaderSignature(data.headerSignature);
      setColumns(data.columns);
      setColumnMap(data.columnMap);
      setMappingReused(Boolean(data.mappingReused));
      setPreviewRows(data.previewRows);
      setTotalProductRows(data.totalProductRows);
      setSanityCheck(data.sanityCheck);
      setUploadType(data.defaultUploadType ?? "full");
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      throw err;
    } finally {
      setLoadingPreview(false);
    }
  };

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

      setHeaderRowWindow(data.headerRowWindow);
      setDetectedHeaderRowIndex(data.detectedHeaderRowIndex);
      setHeaderRowIndex(data.headerRowIndex);
      setHeaderConfident(data.headerConfident);
      setHeaderSignature(data.headerSignature);
      setColumns(data.columns);
      setColumnMap(data.columnMap);
      setMappingReused(Boolean(data.mappingReused));
      setPreviewRows(data.previewRows);
      setTotalProductRows(data.totalProductRows);
      setSanityCheck(data.sanityCheck);
      setUploadType(data.defaultUploadType ?? "full");

      // Reuse only ever skips the column-mapping step — Preview is
      // always shown, regardless.
      setStage(data.mappingReused ? "preview" : "mapping");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStage("idle");
    }
  };

  const changeHeaderRow = async (newIndex: number) => {
    setHeaderRowIndex(newIndex);
    await refreshPreview({ headerRowIndex: newIndex }).catch(() => {});
  };

  const changeColumn = async (field: keyof SupplierColumnMapping["columnMap"], value: number | undefined) => {
    const next = { ...columnMap, [field]: value };
    setColumnMap(next);
    await refreshPreview({ headerRowIndex, columnMap: next }).catch(() => {});
  };

  const submitProcess = async () => {
    if (!blobUrl) return;
    setStage("processing");
    setError(null);
    try {
      const res = await fetch("/api/pricing/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: id, blobUrl, filename, uploadType, headerRowIndex, headerSignature, columnMap }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not process this upload.");
      setResult(data);
      setStage("done");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStage("preview");
    }
  };

  const [retryingId, setRetryingId] = useState<string | null>(null);
  const retryUpload = async (u: SupplierPriceUpload) => {
    if (!supplier?.columnMapping) {
      setError("No remembered column mapping to retry with — upload the file again instead.");
      return;
    }
    setRetryingId(u.id);
    setError(null);
    try {
      const res = await fetch("/api/pricing/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId: id,
          blobUrl: u.blobUrl,
          filename: u.filename,
          uploadType: u.uploadType,
          headerRowIndex: supplier.columnMapping.headerRowIndex,
          headerSignature: supplier.columnMapping.headerSignature,
          columnMap: supplier.columnMapping.columnMap,
          retryUploadId: u.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Retry failed.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setRetryingId(null);
    }
  };

  const reset = () => {
    setStage("idle");
    setBlobUrl(null);
    setColumns([]);
    setColumnMap({});
    setPreviewRows([]);
    setSanityCheck(null);
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
      <main className="mx-auto max-w-[1100px] px-6 py-6">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
            {supplier.name}
            {supplier.status === "archived" && (
              <span className="ml-3 rounded-full bg-ld-border/40 px-2.5 py-1 align-middle text-xs font-semibold uppercase tracking-wide text-ld-muted">
                Archived
              </span>
            )}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="md" onClick={startEdit}>
              Edit
            </Button>
            <Button variant="outline" size="md" disabled={archiving} onClick={toggleArchive}>
              {archiving ? "Saving…" : supplier.status === "archived" ? "Restore Supplier" : "Archive Supplier"}
            </Button>
          </div>
        </div>
        <p className="mb-6 text-sm text-ld-muted">
          {[supplier.country, supplier.defaultCurrency, supplier.orderingMethod].filter(Boolean).join(" · ") || "No profile details yet"}
        </p>

        {error && <div className="glass-panel mb-6 rounded-xl border border-ld-red/30 p-4 text-sm text-ld-red">{error}</div>}

        {editing && (
          <div className="glass-panel mb-6 rounded-2xl p-5">
            <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Edit Supplier</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {EDITABLE_FIELDS.map(([field, label]) => (
                <div key={field}>
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</label>
                  <input
                    value={(editForm[field] as string) ?? ""}
                    onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value }))}
                    className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
                  />
                </div>
              ))}
              <div>
                <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">Ordering Method</label>
                <select
                  value={editForm.orderingMethod ?? ""}
                  onChange={(e) =>
                    setEditForm((f) => ({
                      ...f,
                      orderingMethod: (e.target.value || undefined) as Supplier["orderingMethod"],
                    }))
                  }
                  className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple"
                >
                  <option value="">— None —</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email</option>
                  <option value="portal">Portal</option>
                  <option value="excel">Excel</option>
                  <option value="phone_agent">Phone Agent</option>
                </select>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" disabled={savingEdit} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={savingEdit} onClick={saveEdit}>
                {savingEdit ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </div>
        )}

        {supplier.status === "archived" && (
          <div className="glass-panel mb-6 rounded-2xl border border-ld-amber/30 bg-ld-amber/10 p-4 text-sm text-ld-amber">
            This supplier is archived — it won&apos;t accept new price-list uploads or purchase orders until restored.
          </div>
        )}

        <div className="glass-panel mb-6 rounded-2xl p-5">
          <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Upload Price List</h2>

          {stage === "idle" && (
            <div className="text-center">
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                disabled={supplier.status === "archived"}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                  e.target.value = "";
                }}
              />
              <p className="mb-4 text-sm text-ld-muted">Upload this supplier&apos;s Excel or CSV price list.</p>
              <Button variant="primary" size="lg" disabled={supplier.status === "archived"} onClick={() => inputRef.current?.click()}>
                Choose File
              </Button>
            </div>
          )}

          {stage === "uploading" && <p className="animate-pulse text-sm text-ld-muted">Uploading &amp; reading file…</p>}

          {stage === "mapping" && (
            <div className="space-y-5">
              <div>
                <p className="mb-2 text-sm text-ld-white">
                  Detected header row: <span className="font-semibold text-ld-cyan">Row {headerRowIndex + 1}</span>
                  {!headerConfident && (
                    <span className="ml-2 text-xs font-semibold text-ld-amber">
                      Low confidence — please double-check this is the right row.
                    </span>
                  )}
                </p>
                <div className="max-h-40 overflow-y-auto rounded-xl border border-ld-border">
                  {headerRowWindow.map((row, i) => (
                    <button
                      key={i}
                      onClick={() => changeHeaderRow(i)}
                      className={`flex w-full items-start gap-3 border-b border-ld-border/50 px-3 py-1.5 text-left text-xs last:border-b-0 ${
                        i === headerRowIndex ? "bg-ld-purple/15 text-ld-white" : "text-ld-muted hover:bg-ld-bg-elevated"
                      }`}
                    >
                      <span className="w-12 shrink-0 font-mono">Row {i + 1}</span>
                      <span className="truncate">{row.filter(Boolean).join(" · ") || "(blank row)"}</span>
                      {i === detectedHeaderRowIndex && <span className="ml-auto shrink-0 text-[10px] uppercase text-ld-cyan">Detected</span>}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-ld-muted">
                  Map Each Field to a Spreadsheet Column
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {FIELD_LABELS.map(([field, label]) => (
                    <div key={field}>
                      <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</label>
                      <select
                        value={columnMap[field] ?? ""}
                        onChange={(e) => changeColumn(field, e.target.value === "" ? undefined : Number(e.target.value))}
                        className="w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-2 py-1.5 text-xs text-ld-white outline-none focus:border-ld-purple"
                      >
                        <option value="">— None —</option>
                        {columns.map((c) => (
                          <option key={c.index} value={c.index}>
                            {columnLabel(c)}
                          </option>
                        ))}
                      </select>
                      {columnMap[field] !== undefined && columnAt(columnMap[field])?.samples && columnAt(columnMap[field])!.samples.length > 0 && (
                        <p className="mt-1 truncate text-[10px] text-ld-muted">
                          Sample: {columnAt(columnMap[field])!.samples.join(", ")}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={reset}>
                  Cancel
                </Button>
                <Button variant="primary" disabled={loadingPreview} onClick={() => setStage("preview")}>
                  Continue to Preview
                </Button>
              </div>
            </div>
          )}

          {stage === "preview" && (
            <div className="space-y-5">
              <p className="text-sm text-ld-muted">
                {mappingReused ? (
                  <span className="font-semibold text-ld-green">Using the remembered column layout for this supplier.</span>
                ) : (
                  <span>Header row {headerRowIndex + 1} · {columns.length} columns mapped.</span>
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

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">
                    Preview — First {previewRows.length} of {totalProductRows.toLocaleString()} Product Rows
                  </p>
                  {loadingPreview && <span className="text-xs text-ld-muted">Refreshing…</span>}
                </div>
                <div className="overflow-x-auto rounded-xl border border-ld-border">
                  <table className="w-full min-w-[700px] text-xs">
                    <thead>
                      <tr className="border-b border-ld-border bg-ld-bg-elevated text-left text-[10px] font-bold uppercase tracking-widest text-ld-muted">
                        <th className="px-3 py-2">SKU</th>
                        <th className="px-3 py-2">Description</th>
                        <th className="px-3 py-2">Brand</th>
                        <th className="px-3 py-2">Qty</th>
                        <th className="px-3 py-2">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((r, i) => (
                        <tr key={i} className="border-b border-ld-border/40 last:border-b-0">
                          <td className="px-3 py-1.5 font-mono text-ld-cyan">{r.supplierSku || "—"}</td>
                          <td className="px-3 py-1.5 text-ld-white">{r.description || "—"}</td>
                          <td className="px-3 py-1.5 text-ld-muted">{r.brand || "—"}</td>
                          <td className="px-3 py-1.5 text-ld-muted">{r.quantity ?? "—"}</td>
                          <td className="px-3 py-1.5 text-ld-amber">
                            {r.price > 0 ? `${r.currency} ${r.price}` : "—"}
                          </td>
                        </tr>
                      ))}
                      {previewRows.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-3 py-6 text-center text-ld-muted">
                            No product rows parsed with this mapping.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {sanityCheck && !sanityCheck.ok && (
                <div className="rounded-xl border border-ld-red/30 bg-ld-red/5 p-4">
                  <p className="mb-1 text-sm font-bold text-ld-red">This mapping may be incorrect.</p>
                  {sanityCheck.warnings.map((w, i) => (
                    <p key={i} className="text-xs text-ld-red">{w}</p>
                  ))}
                  <p className="mt-2 text-xs text-ld-muted">
                    Review the parsed preview above, then go back and fix the mapping before continuing.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between">
                <Button variant="ghost" onClick={() => setStage("mapping")}>
                  ← Back — Fix Mapping
                </Button>
                <Button
                  variant="primary"
                  size="lg"
                  disabled={!sanityCheck?.ok || loadingPreview}
                  onClick={submitProcess}
                >
                  Process {totalProductRows.toLocaleString()} Product{totalProductRows === 1 ? "" : "s"}
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
                  <span className="flex items-center gap-2 text-xs text-ld-muted">
                    {u.uploadType} · {new Date(u.startedAt).toLocaleString()} ·{" "}
                    <span className={u.status === "failed" ? "text-ld-red" : "text-ld-green"}>{u.status}</span>
                    {u.status === "failed" && (
                      <button
                        disabled={retryingId === u.id}
                        onClick={() => retryUpload(u)}
                        className="rounded-lg bg-ld-red/15 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-ld-red hover:bg-ld-red/25"
                      >
                        {retryingId === u.id ? "Retrying…" : "Retry"}
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="glass-panel mt-6 rounded-2xl p-5">
          <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Danger Zone</h2>
          {deleteEligibility === null ? (
            <p className="text-sm text-ld-muted">Checking delete eligibility…</p>
          ) : (
            <ConfirmDangerAction
              label="Delete Permanently"
              confirmMessage={`Permanently delete supplier "${supplier.name}"? This cannot be undone.`}
              blockedReasons={deleteEligibility.eligible ? undefined : deleteEligibility.reasons}
              blockedAlternativeLabel="Archive Supplier"
              onConfirm={deleteSupplierPermanently}
            />
          )}
        </div>
      </main>
    </div>
  );
}
