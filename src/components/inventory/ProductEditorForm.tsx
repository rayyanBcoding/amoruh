"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Product, ProductStatus } from "@/lib/types";
import type { InventoryLotWithRemaining } from "@/lib/intake-types";
import { ImageUpload } from "@/components/inventory/ImageUpload";
import { Button } from "@/components/Button";
import { StatusBadge } from "@/components/Badge";
import { formatCurrency } from "@/lib/format";
import { displayStatus } from "@/lib/product-status";
import { getFragranceNotes } from "@/lib/fragrance-notes";
import { computeWeightedAverageLandedCost } from "@/lib/intake-costing";

type FormState = Omit<Product, "fragranceNotes"> & {
  fragranceNotes: string;
};

const BRAND_COLORS = ["#B89A5C", "#2F2E22", "#8fa3c9", "#2fb3a0", "#7a1f1f", "#2e5339", "#1c4fa0"];

function blankProduct(initialValues?: Partial<Product>): Product {
  return {
    id: "",
    sku: "",
    barcode: "",
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
    ...initialValues,
  };
}

function toFormState(product: Product): FormState {
  return {
    ...product,
    fragranceNotes: getFragranceNotes(product).join(", "),
  };
}

function toPayload(form: FormState): Partial<Product> {
  return {
    ...form,
    fragranceNotes: form.fragranceNotes.split(",").map((s) => s.trim()).filter(Boolean),
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

function SummaryStat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-widest text-ld-muted">{label}</p>
      <div className={`mt-1 text-base font-semibold ${accent ?? "text-ld-white"}`}>{value}</div>
    </div>
  );
}

function inputClass(hasError?: boolean) {
  return `w-full rounded-lg border px-3.5 py-2.5 text-sm text-ld-white placeholder:text-ld-muted/50 outline-none focus:ring-4 ${
    hasError
      ? "border-ld-red/60 bg-ld-red/5 focus:border-ld-red focus:ring-ld-red/15"
      : "border-ld-border bg-ld-bg-elevated focus:border-ld-purple focus:ring-ld-purple/15"
  }`;
}

const CONDITION_OPTIONS = [
  "New",
  "Factory Sealed",
  "Tester with Box",
  "Tester No Box",
  "Tester No Cap",
];

export function ProductEditorForm({
  product,
  initialValues,
  createUrl = "/api/products",
  onCreated,
  onCancel,
}: {
  /** Omit (or pass undefined) to render in "Add Product" (create) mode. */
  product?: Product;
  /** Create-mode only: prefill fields (e.g. from an invoice line). */
  initialValues?: Partial<Product>;
  /** Create-mode only: where Save POSTs to. Defaults to the plain product
   *  endpoint; Intake Mode points this at a PO-line-aware route instead
   *  so create + link-to-PO-line happens as one atomic server call. */
  createUrl?: string;
  /** Called instead of navigating to /inventory/[id] after a create —
   *  used when this form is rendered inside a modal (e.g. CreateProductModal)
   *  rather than as its own page. */
  onCreated?: (product: Product) => void;
  /** Called instead of navigating to /inventory on Cancel — same reasoning. */
  onCancel?: () => void;
}) {
  const router = useRouter();
  const isCreate = !product;
  const [form, setForm] = useState<FormState>(toFormState(product ?? blankProduct(initialValues)));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [initialSnapshot, setInitialSnapshot] = useState(() => JSON.stringify(form));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [lots, setLots] = useState<InventoryLotWithRemaining[]>([]);
  const [salesSummary, setSalesSummary] = useState<{ averageSalePrice: number | null; saleCount: number } | null>(
    null
  );
  const dirty = JSON.stringify(form) !== initialSnapshot;

  // Financial summary panel data (edit mode only) — reads from the same
  // lot/cost-layer and sales-aggregate sources Inventory Intake already
  // built, never a second, potentially-conflicting number.
  useEffect(() => {
    if (isCreate || !product) return;
    fetch(`/api/intake/products/${product.id}/lots`)
      .then((res) => (res.ok ? res.json() : { lots: [] }))
      .then((data) => setLots(data.lots ?? []))
      .catch(() => {});
    fetch(`/api/intake/products/${product.id}/sales-summary`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setSalesSummary)
      .catch(() => {});
  }, [isCreate, product]);

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
    const url = isCreate ? createUrl : `/api/products/${product!.id}`;
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
      if (onCreated) {
        onCreated(body as Product);
      } else {
        router.push(`/inventory/${body.id}`);
      }
    }
  };

  const handleCancel = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    if (onCancel) {
      onCancel();
    } else {
      router.push("/inventory");
    }
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

  // Product-level financial summary — Inventory Intake's lot/cost-layer
  // data is the source of truth; Product.cost is only ever the fallback
  // for a product with no PO/lot history yet, and is labeled as such
  // rather than presented as an equal, authoritative landed cost.
  const weightedAvgLandedCost = computeWeightedAverageLandedCost(lots);
  const isLegacyCost = weightedAvgLandedCost === null;
  const displayedLandedCost = weightedAvgLandedCost ?? product?.cost ?? 0;
  const activeLots = [...lots].filter((l) => l.remaining > 0);
  const grossMargin =
    salesSummary?.averageSalePrice != null && weightedAvgLandedCost != null
      ? salesSummary.averageSalePrice - weightedAvgLandedCost
      : null;

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
                {product!.status === "archived" ? "Restore Product" : "Archive Product"}
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

      {!isCreate && product && (
        <div className="mb-6 grid grid-cols-2 gap-4 rounded-xl border border-ld-border bg-ld-bg-elevated p-4 sm:grid-cols-5">
          <SummaryStat label="Inventory" value={`${product.inventory} units`} />
          <SummaryStat label="Status" value={<StatusBadge status={displayStatus(product)} />} />
          <SummaryStat
            label={isLegacyCost ? "Legacy Cost" : "Weighted Avg. Landed Cost"}
            value={formatCurrency(displayedLandedCost)}
            accent={isLegacyCost ? "italic text-ld-muted" : "text-ld-amber"}
          />
          <SummaryStat
            label="Average Sale Price"
            value={salesSummary?.averageSalePrice != null ? formatCurrency(salesSummary.averageSalePrice) : "No sales yet"}
          />
          <SummaryStat
            label="Est. Avg. Gross Margin"
            value={grossMargin != null ? formatCurrency(grossMargin) : "—"}
            accent={grossMargin == null ? undefined : grossMargin >= 0 ? "text-ld-green" : "text-ld-red"}
          />
        </div>
      )}

      {!isCreate && activeLots.length > 0 && (
        <div className="mb-6 rounded-xl border border-ld-border p-4">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-ld-muted">Current Cost Layers</p>
          <div className="space-y-2">
            {activeLots.map((lot) => (
              <div
                key={lot.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-ld-bg-elevated px-3 py-2 text-sm"
              >
                <span className="font-semibold text-ld-white">{lot.poNumber}</span>
                <span className="text-ld-muted">Remaining {lot.remaining}</span>
                <span className="text-ld-amber">Purchase {formatCurrency(lot.unitCost)}</span>
                <span className="text-ld-amber">Freight {formatCurrency(lot.cost.freight)}</span>
                <span className="font-semibold text-ld-purple">Landed {formatCurrency(lot.cost.landed)}</span>
              </div>
            ))}
          </div>
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

          <Field label="AMORUH Live Price ($)" error={fieldErrors.lootPrice}>
            <input
              type="number"
              min={0}
              className={`${inputClass(!!fieldErrors.lootPrice)} border-ld-purple/50`}
              value={form.lootPrice}
              onChange={(e) => set("lootPrice", Number(e.target.value) as never)}
            />
          </Field>

          <Field label="Fragrance Notes (comma separated)">
            <input
              className={inputClass()}
              value={form.fragranceNotes}
              onChange={(e) => set("fragranceNotes", e.target.value)}
              placeholder="e.g. Bergamot, Lemon, Lavender, Cedar, Amber"
            />
          </Field>

          <Field label="Longevity">
            <input
              className={inputClass()}
              value={form.longevity}
              onChange={(e) => set("longevity", e.target.value)}
            />
          </Field>

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

          <div className="border-t border-ld-border pt-4">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="text-xs font-bold uppercase tracking-widest text-ld-muted hover:text-ld-white"
            >
              {advancedOpen ? "▾" : "▸"} Advanced
            </button>
            {advancedOpen && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Minimum Selling Price ($)" error={fieldErrors.minPrice}>
                  <input
                    type="number"
                    min={0}
                    className={inputClass(!!fieldErrors.minPrice)}
                    value={form.minPrice}
                    onChange={(e) => set("minPrice", Number(e.target.value) as never)}
                  />
                </Field>
                <Field label="Projection">
                  <input
                    className={inputClass()}
                    value={form.projection}
                    onChange={(e) => set("projection", e.target.value)}
                  />
                </Field>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
