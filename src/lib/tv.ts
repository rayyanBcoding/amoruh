import type { Product } from "./types";
import type { TVProduct } from "./live-types";
import { getFragranceNotes } from "./fragrance-notes";

// The single place that decides what a customer-facing TV screen is
// allowed to see. An explicit allowlist, not a UI-level hide — see
// TVProduct in live-types.ts for exactly why (finding #6 / guardrail #10
// of the Go Live plan: TV used to receive the entire Product object over
// the wire, including cost/shelf/notes, just not render them).
export function toTVProduct(product: Product): TVProduct {
  return {
    id: product.id,
    brand: product.brand,
    name: product.name,
    image: product.image,
    color: product.color,
    size: product.size,
    concentration: product.concentration,
    retailPrice: product.retailPrice,
    marketPrice: product.marketPrice,
    lootPrice: product.lootPrice,
    fragranceNotes: getFragranceNotes(product),
    projection: product.projection,
    longevity: product.longevity,
    authentic: product.authentic,
  };
}
