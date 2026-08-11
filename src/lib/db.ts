import { promises as fs } from "fs";
import path from "path";
import type { FlashDeal, LiveSnapshot, LiveState, Product, Sale } from "./types";

// -----------------------------------------------------------------------
// Temporary JSON-file "database" for V1.
//
// Everything funnels through the functions in this file, so swapping in a
// real database (Postgres, Supabase, etc.) or a TikTok Shop-backed source
// later only means rewriting this module — every route handler and page
// stays the same.
// -----------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), "data");
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const STATE_PATH = path.join(DATA_DIR, "state.json");

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------

export async function getProducts(): Promise<Product[]> {
  return readJson<Product[]>(PRODUCTS_PATH);
}

export async function getProduct(id: string): Promise<Product | null> {
  const products = await getProducts();
  return products.find((p) => p.id === id) ?? null;
}

export async function findProductByCode(code: string): Promise<Product | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const products = await getProducts();
  return (
    products.find(
      (p) =>
        p.barcode.toUpperCase() === normalized || p.sku.toUpperCase() === normalized
    ) ?? null
  );
}

export async function saveProducts(products: Product[]): Promise<void> {
  await writeJson(PRODUCTS_PATH, products);
}

export async function updateProduct(
  id: string,
  patch: Partial<Product>
): Promise<Product | null> {
  const products = await getProducts();
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  products[idx] = { ...products[idx], ...patch, id: products[idx].id };
  await saveProducts(products);
  return products[idx];
}

// ---------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------

export async function getState(): Promise<LiveState> {
  return readJson<LiveState>(STATE_PATH);
}

export async function saveState(state: LiveState): Promise<void> {
  await writeJson(STATE_PATH, state);
}

export async function patchState(patch: Partial<LiveState>): Promise<LiveState> {
  const current = await getState();
  const next: LiveState = { ...current, ...patch };
  await saveState(next);
  return next;
}

// ---------------------------------------------------------------------
// Snapshot assembly — the single shape every client (dashboard, TV,
// inventory) consumes.
// ---------------------------------------------------------------------

export async function buildSnapshot(): Promise<LiveSnapshot> {
  const [products, state] = await Promise.all([getProducts(), getState()]);
  const byId = new Map(products.map((p) => [p.id, p]));

  return {
    currentProduct: state.currentProductId ? byId.get(state.currentProductId) ?? null : null,
    queue: state.queueIds.map((id) => byId.get(id)).filter((p): p is Product => Boolean(p)),
    recentSales: state.recentSales,
    flashDeal: state.flashDeal,
    allProducts: products,
    updatedAt: new Date().toISOString(),
  };
}

export function makeDefaultFlashDeal(): FlashDeal {
  return { active: false, discountPercent: 20, startedAt: null };
}

export function makeSaleFromProduct(product: Product, price: number): Sale {
  return {
    id: `sale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    productId: product.id,
    sku: product.sku,
    brand: product.brand,
    name: product.name,
    image: product.image,
    color: product.color,
    price,
    soldAt: new Date().toISOString(),
  };
}
