"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Product, ProductStatus } from "@/lib/types";
import { BottleImage } from "@/components/BottleImage";
import { Button } from "@/components/Button";

type FormState = Omit<Product, "topNotes" | "middleNotes" | "baseNotes"> & {
  topNotes: string;
  middleNotes: string;
  baseNotes: string;
};

function toFormState(product: Product): FormState {
  return {
    ...product,
    topNotes: product.topNotes.join(", "),
    middleNotes: product.middleNotes.join(", "),
    baseNotes: product.baseNotes.join(", "),
  };
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-ld-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-ld-border bg-ld-bg-elevated px-3.5 py-2.5 text-sm text-white placeholder:text-ld-muted/50 outline-none focus:border-ld-purple focus:ring-4 focus:ring-ld-purple/20";

const STATUS_OPTIONS: ProductStatus[] = ["active", "draft", "sold_out", "archived"];

export function ProductEditorForm({ product }: { product: Product }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(toFormState(product));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    const payload: Partial<Product> = {
      ...form,
      topNotes: form.topNotes.split(",").map((s) => s.trim()).filter(Boolean),
      middleNotes: form.middleNotes.split(",").map((s) => s.trim()).filter(Boolean),
      baseNotes: form.baseNotes.split(",").map((s) => s.trim()).filter(Boolean),
      retailPrice: Number(form.retailPrice) || 0,
      marketPrice: Number(form.marketPrice) || 0,
      lootPrice: Number(form.lootPrice) || 0,
      inventory: Number(form.inventory) || 0,
    };

    const res = await fetch(`/api/products/${product.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } else {
      window.alert("Failed to save product.");
    }
  };

  return (
    <div className="glass-panel rounded-2xl p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={() => router.push("/inventory")}
          className="text-sm font-semibold text-ld-muted hover:text-white"
        >
          ← Back to Inventory
        </button>
        <div className="flex items-center gap-3">
          {saved && <span className="text-sm font-semibold text-ld-green">Saved ✓</span>}
          <Button variant="primary" size="lg" disabled={saving} onClick={handleSave}>
            {saving ? "Saving…" : "Save Product"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[220px_1fr]">
        <div className="space-y-4">
          <BottleImage src={form.image} alt={form.name} color={form.color} className="h-56" />
          <Field label="Bottle Image Path">
            <input
              className={inputClass}
              value={form.image}
              onChange={(e) => set("image", e.target.value)}
            />
          </Field>
          <Field label="Accent Color">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.color}
                onChange={(e) => set("color", e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-ld-border bg-transparent"
              />
              <input
                className={inputClass}
                value={form.color}
                onChange={(e) => set("color", e.target.value)}
              />
            </div>
          </Field>
          <Field label="Status">
            <select
              className={inputClass}
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
          <Field label="Authenticity">
            <select
              className={inputClass}
              value={form.authentic ? "yes" : "no"}
              onChange={(e) => set("authentic", e.target.value === "yes")}
            >
              <option value="yes">Verified Authentic</option>
              <option value="no">Unverified</option>
            </select>
          </Field>
        </div>

        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Internal SKU">
              <input className={inputClass} value={form.sku} onChange={(e) => set("sku", e.target.value)} />
            </Field>
            <Field label="Barcode">
              <input
                className={`${inputClass} font-mono`}
                value={form.barcode}
                onChange={(e) => set("barcode", e.target.value)}
              />
            </Field>
            <Field label="Shelf Location">
              <input className={inputClass} value={form.shelf} onChange={(e) => set("shelf", e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Brand">
              <input className={inputClass} value={form.brand} onChange={(e) => set("brand", e.target.value)} />
            </Field>
            <Field label="Product Name">
              <input className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Size">
              <input className={inputClass} value={form.size} onChange={(e) => set("size", e.target.value)} />
            </Field>
            <Field label="Inventory Count">
              <input
                type="number"
                min={0}
                className={inputClass}
                value={form.inventory}
                onChange={(e) => set("inventory", Number(e.target.value) as never)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Retail Price ($)">
              <input
                type="number"
                min={0}
                className={inputClass}
                value={form.retailPrice}
                onChange={(e) => set("retailPrice", Number(e.target.value) as never)}
              />
            </Field>
            <Field label="Market Price ($)">
              <input
                type="number"
                min={0}
                className={inputClass}
                value={form.marketPrice}
                onChange={(e) => set("marketPrice", Number(e.target.value) as never)}
              />
            </Field>
            <Field label="Loot Depot Price ($)">
              <input
                type="number"
                min={0}
                className={`${inputClass} border-ld-cyan/50`}
                value={form.lootPrice}
                onChange={(e) => set("lootPrice", Number(e.target.value) as never)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Top Notes (comma separated)">
              <input className={inputClass} value={form.topNotes} onChange={(e) => set("topNotes", e.target.value)} />
            </Field>
            <Field label="Middle Notes (comma separated)">
              <input
                className={inputClass}
                value={form.middleNotes}
                onChange={(e) => set("middleNotes", e.target.value)}
              />
            </Field>
            <Field label="Base Notes (comma separated)">
              <input className={inputClass} value={form.baseNotes} onChange={(e) => set("baseNotes", e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Projection">
              <input
                className={inputClass}
                value={form.projection}
                onChange={(e) => set("projection", e.target.value)}
              />
            </Field>
            <Field label="Longevity">
              <input
                className={inputClass}
                value={form.longevity}
                onChange={(e) => set("longevity", e.target.value)}
              />
            </Field>
          </div>

          <Field label="TikTok Listing Name">
            <input
              className={inputClass}
              value={form.tiktokListing}
              onChange={(e) => set("tiktokListing", e.target.value)}
            />
          </Field>

          <Field label="Notes">
            <textarea
              rows={3}
              className={inputClass}
              value={form.notes ?? ""}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
