"use client";
import { useCallback, useEffect, useState } from "react";
import type { EnrichmentCounts } from "@/lib/intake-live-enrichment";

type Result = EnrichmentCounts & { mode: "preview" | "applied" };
export default function IntakeLiveEnrichmentPage() {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (apply: boolean) => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/internal/intake-live-enrichment", apply ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apply: true }) } : { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed; refresh to check current counts.");
      setResult(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { Promise.resolve().then(() => void run(false)); }, [run]);
  return <main className="mx-auto max-w-2xl space-y-5 p-6 text-ld-white">
    <h1 className="text-2xl font-bold">New-intake LIVE enrichment</h1>
    <p>Fill missing LIVE Notes and full-size retail references for the two intake batches reviewed from the November 20 export. Existing notes, review flags and verified/operator-edited retail references are preserved.</p>
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
      {result.notesUnresolved.length > 0 && <details><summary>Notes left unresolved: {result.notesUnresolved.length}</summary><ul className="mt-2 space-y-2 text-sm">{result.notesUnresolved.map((r) => <li key={r.productId}>{r.productId}: {r.reason}</li>)}</ul></details>}
    </div>}
    <button disabled={busy} onClick={() => void run(false)} className="mr-4 rounded border border-ld-border px-4 py-2">Refresh preview</button>
    <button disabled={busy || !result || result.mode === "applied"} onClick={() => void run(true)} className="rounded bg-ld-purple px-4 py-2 font-bold">{busy ? "Working…" : "Apply enrichment"}</button>
  </main>;
}
