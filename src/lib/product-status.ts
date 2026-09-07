import type { Product, ProductStatus } from "./types";

// ---------------------------------------------------------------------
// Active/Sold Out are fully derived from inventory — never trusted from
// the stored field. Archived is the only status an operator actually
// sets (via the existing Archive/Restore action in ProductEditorForm).
//
// Why: Phase 2 receiving increments Product.inventory directly and never
// touched `status` — so a product created via Intake (stored as
// "draft") stayed stuck on Draft forever even after real stock arrived.
// Rather than have every inventory-changing code path (receiving, Mark
// Sold, the quick +/-/restock buttons) remember to also keep `status` in
// sync, this is computed at display time from the one number that
// actually matters. Same "derive, don't duplicate" pattern already used
// for landed cost and lot remaining.
// ---------------------------------------------------------------------

export function displayStatus(p: Pick<Product, "status" | "inventory">): ProductStatus {
  if (p.status === "archived") return "archived";
  return p.inventory > 0 ? "active" : "sold_out";
}
