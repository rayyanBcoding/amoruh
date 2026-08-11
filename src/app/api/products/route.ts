import { NextResponse } from "next/server";
import { getProducts } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/products — full catalog, used by the Inventory table and search.
export async function GET() {
  const products = await getProducts();
  return NextResponse.json(products);
}
