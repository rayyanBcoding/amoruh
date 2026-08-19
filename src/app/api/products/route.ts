import { NextResponse } from "next/server";
import { createProduct, getProducts, ValidationError } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/products — full catalog, used by the Inventory table and search.
export async function GET() {
  try {
    const products = await getProducts();
    return NextResponse.json(products);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load products: ${errorMessage(err)}` },
      { status: 500 }
    );
  }
}

// POST /api/products — create a new product ("Add Product" flow).
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const product = await createProduct(body as Record<string, unknown>);
    broadcastStateChanged("product-created");
    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: err.message, fields: err.fields },
        { status: err.status }
      );
    }
    return NextResponse.json(
      { error: `Could not create product: ${errorMessage(err)}` },
      { status: 500 }
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
