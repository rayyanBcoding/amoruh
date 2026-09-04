import type { CostBreakdown, PurchaseOrder } from "./intake-types";

// ---------------------------------------------------------------------
// Landed cost math — kept in one place so freight allocation always
// works the same way everywhere it's used (receiving confirm panel, lot
// display, PO summary, audit snapshots).
//
// V1: freight is spread evenly across every unit ORDERED on the PO
// (PurchaseOrder.totalExpectedQty, which never changes once a PO is
// created — see intake-db.ts). duty/other are always 0 for now, but kept
// as real fields so a future landed-cost component doesn't need a data
// migration (spec §11).
// ---------------------------------------------------------------------

export function freightPerUnit(po: Pick<PurchaseOrder, "shippingCost" | "totalExpectedQty">): number {
  if (!po.totalExpectedQty || po.totalExpectedQty <= 0) return 0;
  return po.shippingCost / po.totalExpectedQty;
}

/** Total landed cost for the whole PO (merchandise subtotal + freight). */
export function totalLandedPOCost(po: Pick<PurchaseOrder, "subtotal" | "shippingCost">): number {
  return po.subtotal + po.shippingCost;
}

/** The live cost breakdown for one unit at a given purchase cost, using
 *  the PO's CURRENT freight — this is what makes a later freight edit
 *  (§10) show up everywhere immediately, with nothing to recalculate. */
export function computeCostBreakdown(
  purchaseCost: number,
  po: Pick<PurchaseOrder, "shippingCost" | "totalExpectedQty">
): CostBreakdown {
  const freight = freightPerUnit(po);
  const duty = 0;
  const other = 0;
  return {
    purchase: purchaseCost,
    freight,
    duty,
    other,
    landed: purchaseCost + freight + duty + other,
  };
}
