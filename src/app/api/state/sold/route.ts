import { NextResponse } from "next/server";
import {
  buildSnapshot,
  getProduct,
  getState,
  makeSaleFromProduct,
  patchState,
  updateProduct,
} from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";
import { consumeFromOldestLot } from "@/lib/intake-receiving";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RECENT_SALES = 25;

// POST /api/state/sold — mark the current product sold: decrement
// inventory, log the sale, and flip status to sold_out at zero stock.
export async function POST() {
  try {
    const state = await getState();
    if (!state.currentProductId) {
      return NextResponse.json({ error: "There's no current product to mark sold." }, { status: 400 });
    }

    const product = await getProduct(state.currentProductId);
    if (!product) {
      return NextResponse.json({ error: "The current product no longer exists." }, { status: 404 });
    }

    const salePrice = state.flashDeal.active
      ? Math.round(product.lootPrice * (1 - state.flashDeal.discountPercent / 100))
      : product.lootPrice;

    const nextInventory = Math.max(0, product.inventory - 1);
    await updateProduct(product.id, {
      inventory: nextInventory,
      status: nextInventory === 0 ? "sold_out" : product.status,
    });

    const sale = makeSaleFromProduct(product, salePrice);
    await patchState({
      recentSales: [sale, ...state.recentSales].slice(0, MAX_RECENT_SALES),
    });

    // Best-effort FIFO lot consumption — keeps Intake Mode's cost-layer
    // ledger accurate for stock that came in through a PO. Awaited (not
    // fire-and-forget) so it actually completes before this serverless
    // function returns — but it can never fail the sale or change its
    // outcome: consumeFromOldestLot has its own try/catch and simply
    // returns false on any problem. A product with no lots (predates
    // Intake Mode) is a harmless no-op here.
    await consumeFromOldestLot(product.id, 1, "Live Show — Mark Sold");

    broadcastStateChanged("mark-sold");
    return NextResponse.json(await buildSnapshot());
  } catch (err) {
    return NextResponse.json(
      { error: `Could not mark sold: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
