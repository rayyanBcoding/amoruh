import { NextResponse } from "next/server";
import { getSuppliers, getOrCreateSupplier, updateSupplier } from "@/lib/intake-db";
import type { Supplier } from "@/lib/intake-types";

export const dynamic = "force-dynamic";

// GET /api/pricing/suppliers — list every supplier (shared with Order
// Intake — see intake-db.ts; no separate supplier concept here).
export async function GET() {
  const suppliers = await getSuppliers();
  return NextResponse.json(suppliers);
}

interface CreateBody {
  name?: string;
  profile?: Partial<Supplier>;
}

// POST /api/pricing/suppliers — create (or reuse, by exact name) a
// supplier, then apply any profile fields in one step.
export async function POST(req: Request) {
  let body: CreateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Supplier name is required." }, { status: 400 });
  }

  const supplier = await getOrCreateSupplier(body.name);
  if (body.profile && Object.keys(body.profile).length > 0) {
    const updated = await updateSupplier(supplier.id, body.profile);
    return NextResponse.json(updated ?? supplier);
  }
  return NextResponse.json(supplier);
}
