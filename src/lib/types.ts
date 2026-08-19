// Core domain types for AMORUH Live OS.
//
// Kept intentionally flat and serializable so the same shapes can later be
// swapped onto a different database or a TikTok Shop sync without touching
// consuming components — see src/lib/db.ts for the one place that reads
// and writes these.

export type ProductStatus = "active" | "draft" | "sold_out" | "archived";

export interface Product {
  id: string;
  /** AMORUH internal SKU — what you print on your own shelf/barcode labels. */
  sku: string;
  /** Manufacturer UPC/barcode, or the same as `sku` for house-made codes.
   *  Scanning matches against either this or `sku`. */
  barcode: string;
  brand: string;
  name: string;
  size: string;
  /** e.g. "Eau de Toilette", "Eau de Parfum", "Parfum". */
  concentration: string;
  /** Public URL of the bottle image (Vercel Blob), or "" for none. */
  image: string;
  /** Brand accent color used for placeholder art + UI highlights. */
  color: string;
  /** Wholesale/acquisition cost — never shown on the TV display. */
  cost: number;
  /** MSRP. */
  retailPrice: number;
  marketPrice: number;
  /** AMORUH live price — what's shown as the deal price during the show. */
  lootPrice: number;
  /** Floor price — flash deals should never discount below this. */
  minPrice: number;
  topNotes: string[];
  middleNotes: string[];
  baseNotes: string[];
  projection: string;
  longevity: string;
  description: string;
  /** e.g. "New", "New in Box", "Tester", "Used - Like New". */
  condition: string;
  /** Shelf/vault location — internal only, never shown on the TV display. */
  shelf: string;
  inventory: number;
  authentic: boolean;
  tiktokListing: string;
  status: ProductStatus;
  /** Internal notes — never shown on the TV display. */
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
