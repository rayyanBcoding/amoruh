"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Product, ProductStatus } from "@/lib/types";
import { ImageUpload } from "@/components/inventory/ImageUpload";
import { Button } from "@/components/Button";

type FormState = Omit<Product, "topNotes" | "middleNotes" | "baseNotes"> & {
  topNotes: string;
  middleNotes: string;
  baseNotes: string;
};

const BRAND_COLORS = ["#B89A5C", "#2F2E22", "#8fa3c9", "#2fb3a0", "#7a1f1f", "#2e5339", "#1c4fa0"];

function blankProduct(prefillBarcode?: string): Product {
  return {
    id: "",
    sku: prefillBarcode ?? "",
    barcode: prefillBarcode ?? "",
    brand: "",
    name: "",
    size: "",
    concentration: "",
    image: "",
    color: BRAND_COLORS[Math.floor(Math.random() * BRAND_COLORS.length)],
    cost: 0,
    retailPrice: 0,
    marketPrice: 0,
    lootPrice: 0,
    minPrice: 0,
    topNotes: [],
    middleNotes: [],
    baseNotes: [],
    projection: "",
    longevity: "",
    description: "",
    condition: "New",
    shelf: "",
    inventory: 0,
    authentic: true,
    tiktokListing: "",
    status: "active",
    notes: "",
  };
}

function toFormState(product: Product): FormState {
  return {
    ...product,
    topNotes: product.topNotes.join(", "),
    middleNotes: product.middleNotes.join(", "),
    baseNotes: product.baseNotes.join(", "),
  };
}

function toPayload(form: FormState): Partial<Product> {
  return {
    ...form,
    topNotes: form.topNotes.split(",").map((s) => s.trim()).filter(Boolean),
    middleNotes: form.middleNotes.split(",").map((s) => s.trim()).filter(Boolean),
    baseNotes: form.baseNotes.split(",").map((s) => s.trim()).filter(Boolean),
    cost: Number(form.cost) || 0,
    retailPrice: Number(form.retailPrice) || 0,
    marketPrice: Number(form.marketPrice) || 0,
    lootPrice: Number(form.lootPrice) || 0,
    minPrice: Number(form.minPrice) || 0,
    inventory: Number(form.inventory) || 0,
  };
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">
        {label}
      </span>
      {children}
      {error && <span className="mt-1 block text-xs font-semibold text-ld-red">{error}</span>}
    </label>
  );
}

function inputClass(hasError?: boolean) {
  return `w-full rounded-lg border px-3.5 py-2.5 text-sm text-ld-white placeholder:text-ld-muted/50 outline-none focus:ring-4 ${
    hasError
      ? "border-ld-red/60 bg-ld-red/5 focus:border-ld-red focus:ring-ld-red/15"
      : "border-ld-border bg-ld-bg-elevated focus:border-ld-purple focus:ring-ld-purple/15"
  }`;
}

const STATUS_OPTIONS: ProductStatus[] = ["active", "draft", "sold_out", "archived"];
const CONDITION_OPTIONS = [
  "New",
  "Factory Sealed",
  "Tester with Box",
  "Tester No Box",
  "Tester No Cap",
];

export function ProductEditorForm({
  product,
  prefillBarcode,
}: {
  /** Omit (or pass undefined) to render in "Add Product" (create) mode. */
  product?: Product;
  prefillBarcode?: string;
}) {
  const router = useRouter();
  const isCreate = !product;
  const [form, setForm] = useState<FormState>(toFormState(product ?? blankProduct(prefillBarcode)));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [initialSnapshot, setInitialSnapshot] = useState(() => JSON.stringify(form));
  const dirty = JSON.stringify(form) !== initialSnapshot;

  // Warn on tab close / reload if there are unsaved changes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((f) => {
      if (!(key in f)) return f;
      const next = { ...f };
      delete next[key as string];
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setBannerError(null);
    setFieldErrors({});

    const payload = toPayload(form);
    const url = isCreate ? "/api/products" : `/api/products/${product!.id}`;
    const method = isCreate ? "POST" : "PUT";

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      setSaving(false);
      setBannerError("Network error — check your connection and try again.");
      return;
    }

    const body = await res.json().catch(() => ({}));
    setSaving(false);

    if (!res.ok) {
      setBannerError(body?.error ?? `Save failed (${res.status}).`);
      if (body?.fields) setFieldErrors(body.fields);
      return;
    }

    setInitialSnapshot(JSON.stringify(form));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);

    if (isCreate && body?.id) {
      router.push(`/inventory/${body.id}`);
    }
  };

  const handleCancel = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    router.push("/inventory");
  };

  const handleArchiveToggle = async () => {
    if (!product) return;
    const nextStatus: ProductStatus = product.status === "archived" ? "active" : "archived";
    setSaving(true);
    const res = await fetch(`/api/products/${product.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    setSaving(false);
    if (res.ok) {
      set("status", nextStatus);
      setInitialSnapshot(JSON.stringify({ ...form, status: nextStatus }));
    } else {
      const body = await res.json().catch(() => ({}));
      setBannerError(body?.error ?? "Could not update status.");
    }
  };

  const handleDelete = async () => {
    if (!product) return;
    if (
      !window.confirm(
        `Permanently delete "${product.brand} ${product.name}"? This can't be undone — Archive is usually safer.`
      )
    ) {
      return;
    }
    setDeleting(true);
    const res = await fetch(`/api/products/${product.id}`, { method: "DELETE" });
    setDeleting(false);
    if (res.ok) {
      router.push("/inventory");
    } else {
      const body = await res.json().catch(() => ({}));
      setBannerError(body?.error ?? "Could not delete product.");
    }
  };

  return (
    <div className="glass-panel rounded-2xl p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={handleCancel}
          className="text-sm font-semibold text-ld-muted hover:text-ld-white"
        >
          ← Back to Inventory
        </button>
        <div className="flex flex-wrap items-center gap-3">
          {saved && (
            <span className="text-sm font-semibold text-ld-green">
              {isCreate ? "Created ✓" : "Saved ✓"}
            </span>
          )}
          {!isCreate && (
            <>
              <Button variant="outline" size="md" disabled={saving || deleting} onClick={handleArchiveToggle}>
                {product!.status === "archived" ? "Restore" : "Archive"}
              </Button>
              <Button variant="danger" size="md" disabled={saving || deleting} onClick={handleDelete}>
                {deleting ? "Deleting…" : "Delete Permanently"}
              </Button>
            </>
          )}
          <Button variant="ghost" size="lg" disabled={saving} onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={saving || deleting} onClick={handleSave}>
            {saving ? "Saving…" : isCreate ? "Add Product" : "Save Product"}
          </Button>
        </div>
      </div>

      {bannerError && (
        <div className="mb-6 rounded-xl border border-ld-red/40 bg-ld-red/10 px-4 py-3 text-sm font-medium text-ld-red">
          {bannerError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[220px_1fr]">
        <div className="space-y-4">
          <ImageUpload value={form.image} color={form.color} onChange={(url) => set("image", url)} />
          <Field label="Accent Color">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.color}
                onChange={(e) => set("color", e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-ld-border bg-transparent"
              />
              <input
                className={inputClass()}
                value={form.color}
                onChange={(e) => set("color", e.target.value)}
              />
            </div>
          </Field>
          <Field label="Status">
            <select
              className={inputClass()}
              value={form.status}
              onChange={(e) => set("status", e.target.value as ProductStatus)}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Condition">
            <select
              className={inputClass()}
              value={form.condition}
              onChange={(e) => set("condition", e.target.value)}
            >
              {/* Keep showing a legacy value (e.g. old data just saying "Tester")
                  as its own option rather than silently jumping to "New". */}
              {!CONDITION_OPTIONS.includes(form.condition) && form.condition && (
                <option value={form.condition}>{form.condition}</option>
              )}
              {CONDITION_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Internal SKU" error={fieldErrors.sku}>
              <input
                className={inputClass(!!fieldErrors.sku)}
                value={form.sku}
                onChange={(e) => set("sku", e.target.value)}
              />
            </Field>
            <Field label="Manufacturer UPC / Barcode" error={fieldErrors.barcode}>
              <input
                className={`${inputClass(!!fieldErrors.barcode)} font-mono`}
                value={form.barcode}
                onChange={(e) => set("barcode", e.target.value)}
                placeholder="Defaults to SKU if left blank"
              />
            </Field>
            <Field label="Shelf Location">
              <input className={inputClass()} value={form.shelf} onChange={(e) => set("shelf", e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Brand" error={fieldErrors.brand}>
              <input
                className={inputClass(!!fieldErrors.brand)}
                value={form.brand}
                onChange={(e) => set("brand", e.target.value)}
              />
            </Field>
            <Field label="Product Name" error={fieldErrors.name}>
              <input
                className={inputClass(!!fieldErrors.name)}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Size">
              <input className={inputClass()} value={form.size} onChange={(e) => set("size", e.target.value)} placeholder="e.g. 100ml / 3.4oz" />
            </Field>
            <Field label="Concentration">
              <input
                className={inputClass()}
                value={form.concentration}
                onChange={(e) => set("concentration", e.target.value)}
                placeholder="e.g. Eau de Parfum"
              />
            </Field>
            <Field label="Inventory Quantity" error={fieldErrors.inventory}>
              <input
                type="number"
                min={0}
                className={inputClass(!!fieldErrors.inventory)}
                value={form.inventory}
                onChange={(e) => set("inventory", Number(e.target.value) as never)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Cost ($)" error={fieldErrors.cost}>
              <input
                type="number"
                min={0}
                className={inputClass(!!fieldErrors.cost)}
                value={form.cost}
                onChange={(e) => set("cost", Number(e.target.value) as never)}
              />
            </Field>
            <Field label="MSRP / Retail Price ($)" error={fieldErrors.retailPrice}>
              <input
                type="number"
                min={0}
                className={inputClass(!!fieldErrors.retailPrice)}
                value={form.retailPrice}
                onChange={(e) => set("retailPrice", Number(e.target.value) as never)}
              />
            </Field>
            <Field label="Market Price ($)" error={fieldErrors.marketPrice}>
              <input
                type="number"
                min={0}
                className={inputClass(!!fieldErrors.marketPrice)}
                value={form.marketPrice}
                onChange={(e) => set("marketPrice", Number(e.target.value) as never)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="AMORUH Live Price ($)" error={fieldErrors.lootPrice}>
              <input
                type="number"
                min={0}
                className={`${inputClass(!!fieldErrors.lootPrice)} border-ld-purple/50`}
                value={form.lootPrice}
                onChange={(e) => set("lootPrice", Number(e.target.value) as never)}
              />
            </Field>
            <Field label="Minimum Selling Price ($)" error={fieldErrors.minPrice}>
              <input
                type="number"
                min={0}
                className={inputClass(!!fieldErrors.minPrice)}
                value={form.minPrice}
                onChange={(e) => set("minPrice", Number(e.target.value) as never)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Top Notes (comma separated)">
              <input className={inputClass()} value={form.topNotes} onChange={(e) => set("topNotes", e.target.value)} />
            </Field>
            <Field label="Middle Notes (comma separated)">
              <input
                className={inputClass()}
                value={form.middleNotes}
                onChange={(e) => set("middleNotes", e.target.value)}
              />
            </Field>
            <Field label="Base Notes (comma separated)">
              <input className={inputClass()} value={form.baseNotes} onChange={(e) => set("baseNotes", e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Projection">
              <input
                className={inputClass()}
                value={form.projection}
                onChange={(e) => set("projection", e.target.value)}
              />
            </Field>
            <Field label="Longevity">
              <input
                className={inputClass()}
                value={form.longevity}
                onChange={(e) => set("longevity", e.target.value)}
              />
            </Field>
          </div>

          <Field label="Description">
            <textarea
              rows={2}
              className={inputClass()}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>

          <Field label="TikTok Listing Name / Product ID">
            <input
              className={inputClass()}
              value={form.tiktokListing}
              onChange={(e) => set("tiktokListing", e.target.value)}
            />
          </Field>

          <Field label="Internal Notes">
            <textarea
              rows={3}
              className={inputClass()}
              value={form.notes ?? ""}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
