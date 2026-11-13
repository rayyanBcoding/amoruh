import type { POStatus, PurchaseOrderLine } from "./intake-types";

// ---------------------------------------------------------------------
// When may a PO line's product match be CHANGED or CLEARED?
//
// Only while the intake is still pending — before anything has been received
// against that line. Once stock has been received, the line's productId is what
// that stock was credited to, so silently pointing the line at a different
// product would leave inventory and the PO out of step. Receiving is the only
// thing that moves inventory; changing a match never does.
//
// A line that is not linked yet, or whose linked product no longer exists
// (a stale match), is never blocked — linking / re-matching those is the
// existing repair path and is unchanged.
//
// Shared by the PATCH route, the create-product route and the PO Detail UI so
// the screen and the server can never disagree.
// ---------------------------------------------------------------------

export type LineEditBlockCode = "PO_LOCKED" | "ALREADY_RECEIVED";

export interface LineEditBlock {
  code: LineEditBlockCode;
  message: string;
}

const LOCKED_PO: ReadonlySet<POStatus> = new Set<POStatus>(["received", "closed", "canceled"]);

export function lineMatchEditBlock(
  po: { status: POStatus },
  line: Pick<PurchaseOrderLine, "productId" | "receivedQty">,
  existingProductIds: ReadonlySet<string>
): LineEditBlock | null {
  if (!line.productId || !existingProductIds.has(line.productId)) return null;
  if (LOCKED_PO.has(po.status)) {
    return { code: "PO_LOCKED", message: `This PO is ${po.status === "canceled" ? "canceled" : po.status === "closed" ? "closed" : "fully received"}, so its product matches can no longer be changed.` };
  }
  if (line.receivedQty > 0) {
    return { code: "ALREADY_RECEIVED", message: "Stock has already been received against this line, so its product can't be changed here." };
  }
  return null;
}
