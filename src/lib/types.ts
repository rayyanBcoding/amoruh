// Core domain types for AMORUH Live OS.
//
// Kept intentionally flat and serializable (JSON-file backed for V1) so the
// same shapes can later be swapped onto a real database or TikTok Shop sync
// without touching consuming components.

export type ProductStatus = "active" | "draft" | "sold_out" | "archived";

export interface Product {
  id: string;
  sku: string;
  barcode: string;
  brand: string;
  name: string;
  size: string;
  /** Path to the bottle image (public/ relative) or a data/remote URL. */
  image: string;
  /** Brand accent color used for placeholder art + UI highlights. */
  color: string;
  retailPrice: number;
  marketPrice: number;
  lootPrice: number;
  topNotes: string[];
  middleNotes: string[];
  baseNotes: string[];
  projection: string;
  longevity: string;
  shelf: string;
  inventory: number;
  authentic: boolean;
  tiktokListing: string;
  status: ProductStatus;
  notes?: string;
}

export interface Sale {
  id: string;
  productId: string;
  sku: string;
  brand: string;
  name: string;
  image: string;
  color: string;
  price: number;
  soldAt: string; // ISO timestamp
}

export interface FlashDeal {
  active: boolean;
  discountPercent: number;
  startedAt: string | null;
}

/** Persisted "live show" state — the thing a barcode scan mutates. */
export interface LiveState {
  currentProductId: string | null;
  queueIds: string[];
  recentSales: Sale[];
  flashDeal: FlashDeal;
}

/** Fully hydrated snapshot sent down to clients over SSE / REST. */
export interface LiveSnapshot {
  currentProduct: Product | null;
  queue: Product[];
  recentSales: Sale[];
  flashDeal: FlashDeal;
  allProducts: Product[];
  updatedAt: string;
}
