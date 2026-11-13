"use client";

import { useState } from "react";
import type { Product, LiveNotes } from "@/lib/types";
import { buildLiveNotes, getLiveNotesView } from "@/lib/live-notes";

// The "LIVE Notes" block: Key notes / Vibe / Best for. Read at a glance on Go
// Live; the Edit button opens a 3-field editor that saves ONLY liveNotes
// (PUT /api/products/[id] with { liveNotes }) — never inventory, price, etc.

type Props = {
  product: Pick<Product, "id" | "liveNotes" | "sellingKeyNotes" | "sellingScentProfile" | "fragranceNotes" | "topNotes" | "middleNotes" | "baseNotes">;
  /** Large type for the Go Live screen; compact for the inventory page. */
  size?: "live" | "compact";
  onSaved?: (n: LiveNotes) => void;
};

export function LiveNotesCard({ product, size = "live", onSaved }: Props) {
  const [saved, setSaved] = useState<LiveNotes | undefined>(undefined); // set only after a local save
  const view = getLiveNotesView({ ...product, liveNotes: saved ?? product.liveNotes });
  const [editing, setEditing] = useState(false);
  const [keys, setKeys] = useState("");
  const [vibe, setVibe] = useState("");
  const [bestFor, setBestFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const big = size === "live";

  const startEdit = () => {
    setKeys((view?.keyNotes ?? []).join(", "));
    setVibe(view?.vibe ?? "");
    setBestFor(view?.bestFor ?? "");
    setErr(null);
    setEditing(true);
  };

  const save = async () => {
    const next = buildLiveNotes({ keyNotes: keys, vibe, bestFor }, { source: "manual" });
    if (next.keyNotes.length === 0 && !next.vibe && !next.bestFor) {
      setErr("Add at least one note, a vibe, or a best-for.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/products/${product.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveNotes: next }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Save failed (${res.status})`);
      }
      setSaved(next);
      setEditing(false);
      onSaved?.(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const label = "text-[11px] font-bold uppercase tracking-widest text-ld-cyan";
  const input = "w-full rounded-lg border border-ld-border bg-ld-bg px-3 py-2 text-sm text-ld-white outline-none focus:border-ld-purple";

  return (
    <div data-testid="live-notes" className="rounded-xl border-2 border-ld-purple/50 bg-ld-purple/10 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-widest text-ld-purple">
          LIVE Notes
          {view?.check && !editing && <span className="ml-2 rounded bg-ld-amber/20 px-1.5 py-0.5 text-[10px] text-ld-amber">check before quoting</span>}
        </p>
        {!editing && (
          <button type="button" onClick={startEdit} className="rounded-md px-2 py-0.5 text-[11px] font-semibold text-ld-muted hover:bg-ld-border/40 hover:text-ld-white">
            Edit notes
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <label className="block">
            <span className={label}>Key notes (3–5, comma separated)</span>
            <input className={input} value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="Vanilla, Tonka, Amber" autoFocus />
          </label>
          <label className="block">
            <span className={label}>Vibe</span>
            <input className={input} value={vibe} onChange={(e) => setVibe(e.target.value)} placeholder="Sweet, warm, sexy" />
          </label>
          <label className="block">
            <span className={label}>Best for</span>
            <input className={input} value={bestFor} onChange={(e) => setBestFor(e.target.value)} placeholder="Fall/winter · night out, date" />
          </label>
          {err && <p className="text-xs font-semibold text-ld-red">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button type="button" disabled={busy} onClick={save} className="rounded-lg bg-ld-purple px-3 py-1.5 text-xs font-bold text-ld-white hover:brightness-105 disabled:opacity-50">
              {busy ? "Saving…" : "Save notes"}
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ld-muted hover:text-ld-white">
              Cancel
            </button>
          </div>
        </div>
      ) : view ? (
        <dl className={`space-y-1.5 ${big ? "text-lg leading-snug" : "text-sm"}`}>
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 whitespace-nowrap font-bold text-ld-cyan">Key notes</dt>
            <dd className="font-semibold text-ld-white">{view.keyNotes.length ? view.keyNotes.join(" • ") : "—"}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 whitespace-nowrap font-bold text-ld-cyan">Vibe</dt>
            <dd className="text-ld-white">{view.vibe || "—"}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 whitespace-nowrap font-bold text-ld-cyan">Best for</dt>
            <dd className="text-ld-white">{view.bestFor || "—"}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-ld-muted">No LIVE notes yet — tap <span className="font-semibold text-ld-white">Edit notes</span> to add key notes, vibe and best-for.</p>
      )}
    </div>
  );
}
