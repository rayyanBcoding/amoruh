"use client";

import { useState } from "react";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { InventoryTable } from "@/components/inventory/InventoryTable";
import { useLiveState } from "@/context/LiveStateContext";
import { Button } from "@/components/Button";

type FilterKey = "all" | "active" | "sold_out" | "archived" | "low_stock";

const VALID_FILTERS: FilterKey[] = ["all", "active", "sold_out", "archived", "low_stock"];

// Seeds the table's initial filter from a `?filter=` query param (e.g.
// Dashboard's Low Stock / Out of Stock cards link here) — read once via
// a lazy useState initializer rather than useSearchParams(), which would
// require wrapping this page in a Suspense boundary for no real benefit
// here (this is a client-only convenience, not something that needs to
// be correct during server rendering).
function initialFilterFromUrl(): FilterKey | undefined {
  if (typeof window === "undefined") return undefined;
  const value = new URLSearchParams(window.location.search).get("filter");
  return VALID_FILTERS.includes(value as FilterKey) ? (value as FilterKey) : undefined;
}

export default function InventoryPage() {
  const { snapshot, loading } = useLiveState();
  const [initialFilter] = useState<FilterKey | undefined>(initialFilterFromUrl);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
              Inventory
            </h1>
            <p className="text-sm text-ld-muted">
              Full catalog. Click any product to open the editor.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {snapshot?.currentProduct && (
              <Link href={`/inventory/${snapshot.currentProduct.id}`}>
                <Button variant="outline" size="md">
                  Edit Live Product
                </Button>
              </Link>
            )}
            <Link href="/inventory/new">
              <Button variant="primary" size="md">
                + Add Product
              </Button>
            </Link>
          </div>
        </div>

        {loading || !snapshot ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <p className="animate-pulse text-ld-muted">Loading inventory…</p>
          </div>
        ) : (
          <InventoryTable products={snapshot.allProducts} initialFilter={initialFilter} />
        )}
      </main>
    </div>
  );
}
