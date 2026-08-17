"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Nav } from "@/components/Nav";
import { ProductEditorForm } from "@/components/inventory/ProductEditorForm";
import type { Product } from "@/lib/types";

// Keyed by id so navigating between two product editors remounts this
// (instead of reusing state across ids), which is what naturally resets
// `product` back to "loading" without setState-in-effect gymnastics.
function ProductLoader({ id }: { id: string }) {
  const [product, setProduct] = useState<Product | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/products/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setProduct(data);
      })
      .catch(() => {
        if (!cancelled) setProduct(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (product === undefined) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="animate-pulse text-ld-muted">Loading product…</p>
      </div>
    );
  }
  if (product === null) {
    return (
      <div className="glass-panel rounded-2xl p-10 text-center text-ld-muted">
        Product not found.
      </div>
    );
  }
  return <ProductEditorForm product={product} />;
}

export default function ProductEditorPage() {
  const params = useParams<{ id: string }>();

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1400px] px-6 py-6">
        <h1 className="mb-6 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
          Product Editor
        </h1>
        <ProductLoader key={params.id} id={params.id} />
      </main>
    </div>
  );
}
