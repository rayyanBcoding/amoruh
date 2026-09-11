"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import type { Supplier } from "@/lib/intake-types";

export default function SuppliersPage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const load = () => {
    fetch("/api/pricing/suppliers")
      .then((res) => (res.ok ? res.json() : []))
      .then(setSuppliers)
      .catch(() => {});
  };

  useEffect(load, []);

  const createSupplier = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/pricing/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      const supplier = await res.json();
      if (res.ok) router.push(`/pricing/suppliers/${supplier.id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[900px] px-6 py-6">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">Suppliers</h1>
          <label className="flex items-center gap-2 text-sm text-ld-muted">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
        </div>

        <div className="glass-panel mb-6 flex gap-3 rounded-2xl p-5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createSupplier()}
            placeholder="New supplier name (e.g. Jizan)"
            className="flex-1 rounded-xl border border-ld-border bg-ld-bg-elevated px-4 py-2.5 text-sm text-ld-white placeholder:text-ld-muted/60 outline-none focus:border-ld-purple"
          />
          <Button variant="primary" disabled={creating || !newName.trim()} onClick={createSupplier}>
            {creating ? "Creating…" : "Add Supplier"}
          </Button>
        </div>

        <div className="space-y-2">
          {suppliers
            .filter((s) => showArchived || s.status !== "archived")
            .map((s) => (
              <button
                key={s.id}
                onClick={() => router.push(`/pricing/suppliers/${s.id}`)}
                className="glass-panel flex w-full items-center justify-between rounded-xl px-5 py-4 text-left hover:bg-ld-bg-elevated"
              >
                <div>
                  <p className="font-semibold text-ld-white">
                    {s.name}
                    {s.status === "archived" && (
                      <span className="ml-2 rounded-full bg-ld-border/40 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ld-muted">
                        Archived
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-ld-muted">
                    {[s.country, s.defaultCurrency, s.orderingMethod].filter(Boolean).join(" · ") || "No profile details yet"}
                  </p>
                </div>
                <span className="text-ld-purple">→</span>
              </button>
            ))}
          {suppliers.length === 0 && <p className="text-sm text-ld-muted">No suppliers yet — add one above.</p>}
          {suppliers.length > 0 &&
            suppliers.filter((s) => showArchived || s.status !== "archived").length === 0 && (
              <p className="text-sm text-ld-muted">No active suppliers — check &ldquo;Show archived&rdquo; above.</p>
            )}
        </div>
      </main>
    </div>
  );
}
