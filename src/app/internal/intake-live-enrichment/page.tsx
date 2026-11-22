"use client";
import { useCallback, useEffect, useState } from "react";
import type { EnrichmentCounts } from "@/lib/intake-live-enrichment";

type Totals = { totalInStock: number; completeLiveNotes: number; unresolvedLiveNotes: number; verifiedRetailReferences: number; notVerifiedRetailReferences: number; missingRetailRecords: number; notesFlaggedForReview: number; outsideReviewedCatalog: number };
type Result = EnrichmentCounts & { mode: "preview" | "applied"; totals?: Totals };
export default function IntakeLiveEnrichmentPage() {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (apply: boolean) => {
    setBusy(true); setError("");
    try {
      const scope = new URLSearchParams(window.location.search).get("scope") === "catalog" ? "?scope=catalog" : "";
      const res = await fetch(`/api/internal/intake-live-enrichment${scope}`, apply ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apply: true }) } : { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed; refresh to check current counts.");
      setResult(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { Promise.resolve().then(() => void run(false)); }, [run]);
  return <main className="mx-auto max-w-2xl space-y-5 p-6 text-ld-white">
    <h1 className="text-2xl font-bold">LIVE catalog enrichment</h1>
    <p>Fill missing LIVE Notes and full-size retail references for the reviewed products still in stock. The catalog scope uses the latest supplied production export. Existing notes, review flags and verified/operator-edited retail references are preserved.</p>
    <p className="text-sm text-ld-muted">No inventory, MSRP, costs, sales or quick selling lines are changed. Uncertain prices are marked Not verified; unresolved fragrance notes remain missing.</p>
    {error && <p role="alert" className="text-ld-red">{error}</p>}
    {result && <div role="status" className="space-y-2 rounded border border-ld-border p-4">
      <h2 className="font-bold">{result.mode === "applied" ? "Saved in this run" : "Current preview — not saved"}</h2>
      <p>New LIVE Notes: {result.newLiveNotes}</p>
      <p>Verified Retail Reference: {result.verifiedRetailReference}</p>
      <p>Not verified Retail Reference: {result.notVerifiedRetailReference}</p>
      <p>Existing notes preserved: {result.preservedLiveNotes}</p>
      <p>Existing retail references preserved: {result.preservedRetailReference}</p>
      <p>Changed, unavailable or out-of-stock products skipped: {result.skipped}</p>
      {result.totals && <div className="border-t border-ld-border pt-3">
        <h3 className="font-bold">{result.mode === "preview" ? "Projected catalog totals — not saved" : "Catalog totals after this run"}</h3>
        <p>In stock: {result.totals.totalInStock}</p>
        <p>Complete LIVE Notes: {result.totals.completeLiveNotes}</p>
        <p>Unresolved LIVE Notes: {result.totals.unresolvedLiveNotes}</p>
        <p>Verified retail references: {result.totals.verifiedRetailReferences}</p>
        <p>Not verified retail references: {result.totals.notVerifiedRetailReferences}</p>
        <p>Missing retail records: {result.totals.missingRetailRecords}</p>
        <p>Notes flagged for review: {result.totals.notesFlaggedForReview}</p>
        {result.totals.outsideReviewedCatalog > 0 && <p>New products outside this reviewed batch: {result.totals.outsideReviewedCatalog}</p>}
      </div>}
      {result.notesUnresolved.length > 0 && <details><summary>Notes left unresolved: {result.notesUnresolved.length}</summary><ul className="mt-2 space-y-2 text-sm">{result.notesUnresolved.map((r) => <li key={r.productId}>{r.productId}: {r.reason}</li>)}</ul></details>}
    </div>}
    <button disabled={busy} onClick={() => void run(false)} className="mr-4 rounded border border-ld-border px-4 py-2">Refresh preview</button>
    <button disabled={busy || !result || result.mode === "applied"} onClick={() => void run(true)} className="rounded bg-ld-purple px-4 py-2 font-bold">{busy ? "Working…" : "Apply enrichment"}</button>
  </main>;
}
