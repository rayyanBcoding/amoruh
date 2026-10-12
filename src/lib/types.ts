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
  /** Unified fragrance notes — the real field going forward. Undefined/empty
   *  on products never edited under the new system; see
   *  src/lib/fragrance-notes.ts for the display fallback that merges
   *  topNotes/middleNotes/baseNotes in that case. topNotes/middleNotes/
   *  baseNotes are kept for backward compatibility and are never cleared. */
  fragranceNotes?: string[];
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

  // -------------------------------------------------------------------
  // Researched selling reference — auto-populated by
  // scripts/enrich-fragrance-selling-notes.ts for IN-STOCK products only
  // (see needsSellingNotesResearch, src/lib/selling-notes.ts). Completely
  // separate from the legacy fragranceNotes/topNotes/middleNotes/
  // baseNotes fields above (those stay directly operator-editable via the
  // Product Editor's own "Fragrance Notes" field, untouched by this
  // system) and from manualSellingNote below. Never written by any
  // Pricing/Ordering or Master Product code path.
  // -------------------------------------------------------------------
  /** Max 3–5 notes, official-source-preferred. Absent/empty = not yet
   *  researched, or researched with insufficient confidence to fill in —
   *  see sellingNotesStatus to tell those two apart. */
  sellingKeyNotes?: string[];
  /** Max 2–3 short descriptors, e.g. ["Fresh", "Fruity", "Smoky"]. */
  sellingScentProfile?: string[];
  /** One concise sentence, e.g. "Perfect fall fragrance with jasmine,
   *  amber, and oud notes." */
  sellingQuickLine?: string;
  sellingNotesSourceName?: string;
  sellingNotesSourceUrl?: string;
  /** ISO timestamp of the most recent research ATTEMPT — set whether or
   *  not it succeeded. Never use this alone to decide eligibility for
   *  re-research; see needsSellingNotesResearch, which checks for
   *  complete content instead. */
  sellingNotesResearchedAt?: string;
  /** Records what the most recent attempt concluded, independent of
   *  whether it filled in any content — "insufficient_confidence" is a
   *  real, stored outcome (per the no-guessing rule), not just an absent
   *  timestamp, and keeps the product correctly eligible for a future
   *  re-attempt (e.g. once a better source becomes available). */
  sellingNotesStatus?: "complete" | "insufficient_confidence";
  /** Operator-editable seller talking points ("sells well on live",
   *  "similar vibe to X") — never written or overwritten by research. */
  manualSellingNote?: string;
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
