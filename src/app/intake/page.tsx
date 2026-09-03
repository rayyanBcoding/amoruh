"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Button } from "@/components/Button";
import { POStatusBadge } from "@/components/intake/IntakeBadges";
import { formatCurrency, formatDate } from "@/lib/format";
import type { PurchaseOrder } from "@/lib/intake-types";

const GROUPS: { title: string; statuses: PurchaseOrder["status"][] }[] = [
  { title: "Open", statuses: ["awaiting_delivery"] },
  { title: "Partially Received", statuses: ["partially_received"] },
  { title: "Completed", statuses: ["received", "closed"] },
];

function POCard({ po }: { po: PurchaseOrder }) {
  const pct = po.totalExpectedQty > 0 ? Math.round((po.totalReceivedQty / po.totalExpectedQty) * 100) : 0;
  return (
    <Link
      href={`/intake/${po.id}`}
      className="glass-panel block rounded-2xl p-5 transition-colors hover:bg-ld-border/20"
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-bold text-ld-white">{po.poNumber}</p>
          <p className="text-sm text-ld-muted">{po.supplierName}</p>
        </div>
        <POStatusBadge status={po.status} />
      </div>
      <div className="mt-4 flex items-center justify-between text-sm text-ld-muted">
        <span>{formatDate(po.invoiceDate)}</span>
        <span>{po.lineCount} line{po.lineCount === 1 ? "" : "s"}</span>
      </div>
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-xs font-semibold text-ld-muted">
          <span>
            {po.totalReceivedQty} / {po.totalExpectedQty} units received
          </span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-ld-border/40">
          <div
            className="h-full rounded-full bg-gradient-to-r from-ld-purple to-ld-cyan"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      </div>
      <p className="mt-3 text-right text-sm font-semibold text-ld-amber">{formatCurrency(po.subtotal)}</p>
    </Link>
  );
}

export default function IntakeDashboardPage() {
  const [pos, setPOs] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/intake/pos")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load."))))
      .then((data) => {
        if (!cancelled) setPOs(data.pos);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
              Inventory Intake
            </h1>
            <p className="text-sm text-ld-muted">
              Purchase orders, invoices, receiving, and cost-by-PO tracking.
            </p>
          </div>
          <Link href="/intake/upload">
            <Button variant="primary" size="md">
              + Upload Invoice / PO
            </Button>
          </Link>
        </div>

        {error && (
          <div className="glass-panel mb-6 rounded-xl border border-ld-red/30 p-4 text-sm text-ld-red">{error}</div>
        )}

        {!pos ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <p className="animate-pulse text-ld-muted">Loading purchase orders…</p>
          </div>
        ) : pos.length === 0 ? (
          <div className="glass-panel rounded-2xl p-10 text-center text-ld-muted">
            No purchase orders yet.{" "}
            <Link href="/intake/upload" className="font-semibold text-ld-purple hover:underline">
              Upload your first invoice
            </Link>{" "}
            to get started.
          </div>
        ) : (
          <div className="space-y-8">
            {GROUPS.map((group) => {
              const items = pos.filter((po) => group.statuses.includes(po.status));
              if (items.length === 0) return null;
              return (
                <div key={group.title}>
                  <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-ld-muted">
                    {group.title} · {items.length}
                  </h2>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((po) => (
                      <POCard key={po.id} po={po} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
