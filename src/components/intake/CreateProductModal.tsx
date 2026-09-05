"use client";

import { Overlay } from "@/components/Overlay";
import { ProductEditorForm } from "@/components/inventory/ProductEditorForm";
import type { Product } from "@/lib/types";

/**
 * "Create New Product From Invoice" — the fix for the old target="_blank"
 * link that only ever prefilled a barcode and had no way to report the
 * created product back to the PO line that spawned it. Reuses
 * ProductEditorForm as-is (all its fields, validation, and error
 * handling) rather than building a second form; the only difference from
 * the standalone /inventory/new page is that Save reports back to
 * `onCreated` instead of navigating away.
 */
export function CreateProductModal({
  initialValues,
  createUrl,
  onCreated,
  onClose,
}: {
  initialValues: Partial<Product>;
  /** Defaults to /api/products (used by the pre-save Review screen).
   *  PO Detail points this at the PO-line-aware create-and-link route so
   *  creating the product and linking it to the line happen atomically
   *  on the server. */
  createUrl?: string;
  onCreated: (product: Product) => void;
  onClose: () => void;
}) {
  return (
    <Overlay size="xl">
      <h2 className="mb-4 font-display text-lg font-bold text-ld-white">Create New Product From Invoice</h2>
      <ProductEditorForm
        initialValues={initialValues}
        createUrl={createUrl}
        onCreated={onCreated}
        onCancel={onClose}
      />
    </Overlay>
  );
}
