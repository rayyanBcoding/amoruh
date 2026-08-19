import type { Product } from "./types";

// Thrown by validateProductInput; route handlers catch this specifically
// and turn it into a real 400 with field-level messages instead of a bare
// 500. This is the fix for "saving throws a generic error" — errors now
// carry a status + human-readable reason all the way to the client.
export class ValidationError extends Error {
  status: number;
  fields: Record<string, string>;

  constructor(message: string, fields: Record<string, string> = {}, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
    this.fields = fields;
  }
}

const REQUIRED_ON_CREATE: (keyof Product)[] = ["sku", "brand", "name"];
const NON_NEGATIVE_NUMERIC_FIELDS: (keyof Product)[] = [
  "cost",
  "retailPrice",
  "marketPrice",
  "lootPrice",
  "minPrice",
  "inventory",
];

export function validateProductInput(
  input: Partial<Product>,
  opts: { existingProducts: Product[]; excludeId?: string; isCreate: boolean }
): void {
  const fields: Record<string, string> = {};

  if (opts.isCreate) {
    for (const key of REQUIRED_ON_CREATE) {
      const value = input[key];
      if (typeof value !== "string" || !value.trim()) {
        fields[key] = `${fieldLabel(key)} is required.`;
      }
    }
  }

  for (const key of NON_NEGATIVE_NUMERIC_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
      fields[key] = `${fieldLabel(key)} must be a number that isn't negative.`;
    }
  }

  if (
    typeof input.retailPrice === "number" &&
    typeof input.lootPrice === "number" &&
    input.lootPrice > input.retailPrice &&
    input.retailPrice > 0
  ) {
    fields.lootPrice = "AMORUH live price is higher than retail — double check this.";
  }

  if (input.sku?.trim()) {
    const normalized = input.sku.trim().toUpperCase();
    const dupe = opts.existingProducts.find(
      (p) => p.id !== opts.excludeId && p.sku.toUpperCase() === normalized
    );
    if (dupe) {
      fields.sku = `SKU "${input.sku.trim()}" is already used by ${dupe.brand} ${dupe.name}.`;
    }
  }

  if (input.barcode?.trim()) {
    const normalized = input.barcode.trim().toUpperCase();
    const dupe = opts.existingProducts.find(
      (p) => p.id !== opts.excludeId && p.barcode.toUpperCase() === normalized
    );
    if (dupe) {
      fields.barcode = `Barcode/UPC "${input.barcode.trim()}" is already used by ${dupe.brand} ${dupe.name}.`;
    }
  }

  if (Object.keys(fields).length > 0) {
    throw new ValidationError("Please fix the highlighted fields.", fields);
  }
}

function fieldLabel(key: keyof Product): string {
  const labels: Partial<Record<keyof Product, string>> = {
    sku: "Internal SKU",
    barcode: "Manufacturer UPC / Barcode",
    brand: "Brand",
    name: "Product name",
    cost: "Cost",
    retailPrice: "MSRP / Retail price",
    marketPrice: "Market price",
    lootPrice: "AMORUH live price",
    minPrice: "Minimum selling price",
    inventory: "Inventory quantity",
  };
  return labels[key] ?? String(key);
}
