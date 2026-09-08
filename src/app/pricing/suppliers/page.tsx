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
        <h1 className="mb-6 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">Suppliers</h1>

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
          {suppliers.map((s) => (
            <button
              key={s.id}
              onClick={() => router.push(`/pricing/suppliers/${s.id}`)}
              className="glass-panel flex w-full items-center justify-between rounded-xl px-5 py-4 text-left hover:bg-ld-bg-elevated"
            >
              <div>
                <p className="font-semibold text-ld-white">{s.name}</p>
                <p className="text-xs text-ld-muted">
                  {[s.country, s.defaultCurrency, s.orderingMethod].filter(Boolean).join(" · ") || "No profile details yet"}
                </p>
              </div>
              <span className="text-ld-purple">→</span>
            </button>
          ))}
          {suppliers.length === 0 && <p className="text-sm text-ld-muted">No suppliers yet — add one above.</p>}
        </div>
      </main>
    </div>
  );
}
