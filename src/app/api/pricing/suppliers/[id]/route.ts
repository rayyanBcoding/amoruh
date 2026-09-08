import { NextResponse } from "next/server";
import { getSupplier, updateSupplier } from "@/lib/intake-db";
import { getUploadsForSupplier } from "@/lib/pricing-db";
import type { Supplier } from "@/lib/intake-types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supplier = await getSupplier(id);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
  const uploads = await getUploadsForSupplier(id, 20);
  return NextResponse.json({ supplier, uploads });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let patch: Partial<Supplier>;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const updated = await updateSupplier(id, patch);
  if (!updated) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
  return NextResponse.json(updated);
}
