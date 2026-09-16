import { NextResponse } from "next/server";
import { getReferenceProduct } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

// GET /api/pricing/reference-products/[id] — single Master/Reference
// Product lookup, mirroring /api/products/[id] for the real catalog.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getReferenceProduct(id);
  if (!product) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(product);
}
