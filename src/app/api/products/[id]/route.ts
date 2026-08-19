import { NextResponse } from "next/server";
import { deleteProduct, getProduct, updateProduct, ValidationError } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/products/[id]
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const product = await getProduct(id);
    if (!product) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }
    return NextResponse.json(product);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load product: ${errorMessage(err)}` },
      { status: 500 }
    );
  }
}

// PUT /api/products/[id] — used by the Product Editor's Save button.
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;

  let patch: Record<string, unknown>;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  delete patch.id;

  try {
    const updated = await updateProduct(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    // The edited product may be the one currently live or in queue — let
    // the dashboard / TV pick up the new price, image, notes, etc. instantly.
    broadcastStateChanged("product-updated");

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: err.message, fields: err.fields },
        { status: err.status }
      );
    }
    return NextResponse.json(
      { error: `Could not save product: ${errorMessage(err)}` },
      { status: 500 }
    );
  }
}

// DELETE /api/products/[id] — hard delete. The editor UI prefers archiving
// (PUT with { status: "archived" }); this is for genuine mistakes/dupes.
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const deleted = await deleteProduct(id);
    if (!deleted) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }
    broadcastStateChanged("product-deleted");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not delete product: ${errorMessage(err)}` },
      { status: 500 }
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
