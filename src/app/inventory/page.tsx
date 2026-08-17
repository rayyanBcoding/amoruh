"use client";

import Link from "next/link";
import { Nav } from "@/components/Nav";
import { InventoryTable } from "@/components/inventory/InventoryTable";
import { useLiveState } from "@/context/LiveStateContext";
import { Button } from "@/components/Button";

export default function InventoryPage() {
  const { snapshot, loading } = useLiveState();

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
          {snapshot?.currentProduct && (
            <Link href={`/inventory/${snapshot.currentProduct.id}`}>
              <Button variant="outline" size="md">
                Edit Live Product
              </Button>
            </Link>
          )}
        </div>

        {loading || !snapshot ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <p className="animate-pulse text-ld-muted">Loading inventory…</p>
          </div>
        ) : (
          <InventoryTable products={snapshot.allProducts} />
        )}
      </main>
    </div>
  );
}
