import { NextResponse } from "next/server";
import { getProduct, updateProduct } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/products/[id]
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const product = await getProduct(id);
  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }
  return NextResponse.json(product);
}

// PUT /api/products/[id] — used by the Product Editor's Save button.
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const patch = await req.json();
  delete patch.id;

  const updated = await updateProduct(id, patch);
  if (!updated) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  // The edited product may be the one currently live or in queue — let the
  // dashboard / TV pick up the new price, image, notes, etc. instantly.
  broadcastStateChanged("product-updated");

  return NextResponse.json(updated);
}
