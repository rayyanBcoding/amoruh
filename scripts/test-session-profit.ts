// Session profit: partial coverage instead of hiding the whole number.
//   npx tsx scripts/test-session-profit.ts
import { computeSessionProfit } from "../src/lib/session-profit";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.log(`FAIL: ${label}\n   expected ${JSON.stringify(expected)}\n   got      ${JSON.stringify(actual)}`);
  }
}

const all = computeSessionProfit([
  { price: 50, quantity: 1, landedCostAtSale: 30 },
  { price: 100, quantity: 2, landedCostAtSale: 40 },
]);
check("every order costed: profit = 150 - (30 + 80)", all, { costOfGoods: 110, estimatedGrossProfit: 40, ordersMissingCost: 0, costedRevenue: 150 });

const some = computeSessionProfit([
  { price: 50, quantity: 1, landedCostAtSale: 30 },
  { price: 19, quantity: 1, landedCostAtSale: null }, // product with no received-stock cost
  { price: 21, quantity: 1, landedCostAtSale: undefined }, // legacy record missing the field
]);
check("a few orders without cost no longer hide profit", some.estimatedGrossProfit, 20);
check("...cost covers only the costed orders", some.costOfGoods, 30);
check("...and the excluded orders are counted", some.ordersMissingCost, 2);
check("...margin base is the costed revenue only", some.costedRevenue, 50);

check("no order has a cost: profit stays unknown", computeSessionProfit([{ price: 10, quantity: 1, landedCostAtSale: null }]), {
  costOfGoods: 0,
  estimatedGrossProfit: null,
  ordersMissingCost: 1,
  costedRevenue: 0,
});
check("no sales: profit unknown, nothing missing", computeSessionProfit([]), { costOfGoods: 0, estimatedGrossProfit: null, ordersMissingCost: 0, costedRevenue: 0 });
check("a zero cost is a real cost, not 'missing'", computeSessionProfit([{ price: 10, quantity: 1, landedCostAtSale: 0 }]), {
  costOfGoods: 0,
  estimatedGrossProfit: 10,
  ordersMissingCost: 0,
  costedRevenue: 10,
});
// the shape of the real session that prompted this: 51 sold, 3 without cost
const real = computeSessionProfit([
  ...Array.from({ length: 48 }, () => ({ price: 36.625, quantity: 1, landedCostAtSale: 34.30 })),
  { price: 19, quantity: 1, landedCostAtSale: null },
  { price: 21, quantity: 1, landedCostAtSale: null },
  { price: 24, quantity: 1, landedCostAtSale: null },
]);
check("51 sold / 3 uncosted: profit shown, 3 excluded", [real.estimatedGrossProfit !== null, real.ordersMissingCost], [true, 3]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
