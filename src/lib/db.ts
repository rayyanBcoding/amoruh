import { KEYS, redis } from "./kv";
import { ValidationError, validateProductInput } from "./validation";
import type { FlashDeal, LiveSnapshot, LiveState, Product, Sale } from "./types";

// -----------------------------------------------------------------------
// Data layer, backed by Upstash Redis. Everything funnels through the
// functions in this file, so swapping in a different store later only
// means rewriting this module — every route handler and page stays the
// same.
//
// History: V1 used a local JSON file here. That broke in production
// because Vercel serverless functions get a read-only filesystem —
// `fs.writeFile` throws EROFS. Redis gives every function instance a
// shared, writable place to read/write the same data.
// -----------------------------------------------------------------------

function defaultState(): LiveState {
  return {
    currentProductId: null,
    queueIds: [],
    recentSales: [],
    flashDeal: makeDefaultFlashDeal(),
  };
}

async function bumpVersion(): Promise<void> {
  await redis.incr(KEYS.version);
}

// ---------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------

export async function getProducts(): Promise<Product[]> {
  const products = await redis.get<Product[]>(KEYS.products);
  return products ?? [];
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
  await redis.set(KEYS.products, products);
  await bumpVersion();
}

/** Creates a new product. Throws ValidationError on bad/duplicate input. */
export async function createProduct(input: Partial<Product>): Promise<Product> {
  const products = await getProducts();
  validateProductInput(input, { existingProducts: products, isCreate: true });

  const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const product: Product = {
    id,
    sku: input.sku!.trim(),
    barcode: input.barcode?.trim() || input.sku!.trim(),
    brand: input.brand!.trim(),
    name: input.name!.trim(),
    size: input.size?.trim() || "",
    concentration: input.concentration?.trim() || "",
    image: input.image?.trim() || "",
    color: input.color?.trim() || "#B89A5C",
    cost: numberOrZero(input.cost),
    retailPrice: numberOrZero(input.retailPrice),
    marketPrice: numberOrZero(input.marketPrice),
    lootPrice: numberOrZero(input.lootPrice),
    minPrice: numberOrZero(input.minPrice),
    topNotes: input.topNotes ?? [],
    middleNotes: input.middleNotes ?? [],
    baseNotes: input.baseNotes ?? [],
    projection: input.projection?.trim() || "",
    longevity: input.longevity?.trim() || "",
    description: input.description?.trim() || "",
    condition: input.condition?.trim() || "New",
    shelf: input.shelf?.trim() || "",
    inventory: Math.max(0, Math.round(numberOrZero(input.inventory))),
    authentic: input.authentic ?? true,
    tiktokListing: input.tiktokListing?.trim() || "",
    status: input.status ?? "active",
    notes: input.notes?.trim() || undefined,
  };

  await saveProducts([...products, product]);
  return product;
}

/** Partially updates a product. Throws ValidationError on bad/duplicate input. */
export async function updateProduct(
  id: string,
  patch: Partial<Product>
): Promise<Product | null> {
  const products = await getProducts();
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return null;

  validateProductInput(patch, { existingProducts: products, excludeId: id, isCreate: false });

  products[idx] = { ...products[idx], ...patch, id: products[idx].id };
  await saveProducts(products);
  return products[idx];
}

/** Hard-deletes a product. Prefer archiving (status: "archived") in the UI;
 *  this exists for genuine mistakes / duplicate entries. */
export async function deleteProduct(id: string): Promise<boolean> {
  const products = await getProducts();
  const next = products.filter((p) => p.id !== id);
  if (next.length === products.length) return false;
  await saveProducts(next);

  // A deleted product can't stay the live/queued item.
  const state = await getState();
  const patch: Partial<LiveState> = {};
  if (state.currentProductId === id) patch.currentProductId = null;
  if (state.queueIds.includes(id)) patch.queueIds = state.queueIds.filter((qid) => qid !== id);
  if (Object.keys(patch).length > 0) await patchState(patch);

  return true;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && !Number.isNaN(value) ? value : 0;
}

export { ValidationError };

// ---------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------

export async function getState(): Promise<LiveState> {
  const state = await redis.get<LiveState>(KEYS.state);
  return state ?? defaultState();
}

export async function saveState(state: LiveState): Promise<void> {
  await redis.set(KEYS.state, state);
  await bumpVersion();
}

export async function patchState(patch: Partial<LiveState>): Promise<LiveState> {
  const current = await getState();
  const next: LiveState = { ...current, ...patch };
  await saveState(next);
  return next;
}

// ---------------------------------------------------------------------
// Version (used by the SSE route to detect changes cheaply)
// ---------------------------------------------------------------------

export async function getVersion(): Promise<number> {
  const version = await redis.get<number>(KEYS.version);
  return version ?? 0;
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
