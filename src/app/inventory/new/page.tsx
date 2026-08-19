"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Nav } from "@/components/Nav";
import { ProductEditorForm } from "@/components/inventory/ProductEditorForm";

function NewProductForm() {
  const searchParams = useSearchParams();
  const prefillBarcode = searchParams.get("barcode") ?? undefined;
  return <ProductEditorForm prefillBarcode={prefillBarcode} />;
}

export default function NewProductPage() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-[1400px] px-6 py-6">
        <h1 className="mb-6 font-display text-2xl font-extrabold text-ld-white lg:text-3xl">
          Add Product
        </h1>
        <Suspense fallback={null}>
          <NewProductForm />
        </Suspense>
      </main>
    </div>
  );
}
