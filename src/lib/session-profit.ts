// Session profit from sold orders — pure, shared by getSessionStats.
//
// Profit used to be shown ONLY when every sold order had a cost basis, so a
// single sale of a product with no received-lot data (e.g. a hand-added
// product) hid the whole session's profit as "—". Now profit is computed over
// the orders that DO have a cost, and the number of orders left out is
// reported so the UI can say so ("excl. 3 orders without cost") instead of
// showing nothing. Revenue always counts every sold order.

export interface ProfitSale {
  price: number;
  quantity: number | null | undefined;
  landedCostAtSale: number | null | undefined;
}

export interface SessionProfit {
  /** Σ(unit cost × quantity) over orders that have a cost basis. */
  costOfGoods: number;
  /** Revenue minus cost over the costed orders only; null when none has a cost. */
  estimatedGrossProfit: number | null;
  /** Sold orders with no cost basis — left out of cost and profit. */
  ordersMissingCost: number;
}

export function computeSessionProfit(sold: ProfitSale[]): SessionProfit {
  const costed = sold.filter((s) => s.landedCostAtSale != null);
  const costOfGoods = costed.reduce((sum, s) => sum + (s.landedCostAtSale as number) * (s.quantity ?? 0), 0);
  const costedRevenue = costed.reduce((sum, s) => sum + s.price, 0);
  return {
    costOfGoods,
    estimatedGrossProfit: costed.length > 0 ? costedRevenue - costOfGoods : null,
    ordersMissingCost: sold.length - costed.length,
  };
}
