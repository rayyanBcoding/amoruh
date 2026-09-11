import { getPO, getReceivingEvents, getLotsForPO, getAllInventoryTransactions } from "./intake-db";

/** Shared by the delete-eligibility GET route (a preview for the UI) and
 *  the DELETE handler on the PO route (which re-runs this exact check
 *  immediately before deleting — never trusts a prior GET result, same
 *  "re-verify at commit time" discipline used everywhere else in this
 *  codebase). A PO is only eligible for hard delete when it has never
 *  been touched by receiving: zero received quantity, no ReceivingEvent,
 *  no InventoryLot, and no InventoryTransaction reference it. Those last
 *  three together also cover "no downstream fulfillment/sales
 *  dependency" — a sale can only consume a lot that exists, and no lot
 *  exists once these hold. */
export async function checkPODeleteEligibility(poId: string): Promise<{ eligible: boolean; reasons: string[] }> {
  const po = await getPO(poId);
  if (!po) return { eligible: false, reasons: ["Purchase order not found."] };
  const reasons: string[] = [];

  if (po.totalReceivedQty > 0) {
    reasons.push(`${po.totalReceivedQty} unit${po.totalReceivedQty === 1 ? "" : "s"} already received against this PO.`);
  }

  const [events, lots, allTransactions] = await Promise.all([
    getReceivingEvents({ poId }),
    getLotsForPO(poId),
    getAllInventoryTransactions(),
  ]);

  if (events.length > 0) {
    reasons.push(`${events.length} receiving event${events.length === 1 ? "" : "s"} recorded against this PO.`);
  }
  if (lots.length > 0) {
    reasons.push(`${lots.length} inventory lot${lots.length === 1 ? "" : "s"} were created from this PO.`);
  }
  const transactions = allTransactions.filter((t) => t.poId === poId);
  if (transactions.length > 0) {
    reasons.push(`${transactions.length} inventory transaction${transactions.length === 1 ? "" : "s"} reference this PO.`);
  }

  return { eligible: reasons.length === 0, reasons };
}
