import { NextResponse } from "next/server";
import { getProduct, updateProduct } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/products/[id]/inventory { action: "increment" | "decrement" | "set" | "restock" | "sold_out", value?: number }
//
// Quick inventory controls for the Inventory table (+1 / -1 / set quantity
// / restock / mark sold out) without going through the full product editor.
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    const product = await getProduct(id);
    if (!product) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    let nextInventory = product.inventory;
    switch (action) {
      case "increment":
        nextInventory = product.inventory + 1;
        break;
      case "decrement":
        nextInventory = Math.max(0, product.inventory - 1);
        break;
      case "set": {
        const value = Number(body?.value);
        if (!Number.isFinite(value) || value < 0) {
          return NextResponse.json(
            { error: "Quantity must be a non-negative number." },
            { status: 400 }
          );
        }
        nextInventory = Math.round(value);
        break;
      }
      case "restock": {
        const value = Number(body?.value);
        nextInventory = product.inventory + (Number.isFinite(value) && value > 0 ? Math.round(value) : 10);
        break;
      }
      case "sold_out":
        nextInventory = 0;
        break;
      default:
        return NextResponse.json(
          { error: `Unknown inventory action "${action}".` },
          { status: 400 }
        );
    }

    const updated = await updateProduct(id, {
      inventory: nextInventory,
      status:
        nextInventory === 0
          ? "sold_out"
          : product.status === "sold_out"
            ? "active"
            : product.status,
    });

    broadcastStateChanged("inventory-adjusted");
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not update inventory: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
