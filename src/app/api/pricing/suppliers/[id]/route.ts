import { NextResponse } from "next/server";
import { getSupplier, updateSupplier, deleteSupplier } from "@/lib/intake-db";
import { getUploadsForSupplier } from "@/lib/pricing-db";
import { checkSupplierDeleteEligibility } from "@/lib/supplier-delete";
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

// DELETE /api/pricing/suppliers/[id] — hard delete. Re-runs the exact
// same eligibility check the GET .../delete-eligibility route offers as
// a preview — never trusts that a client-side confirm already checked
// it. Blocked (409, with reasons) whenever ANY real history exists;
// Archive (PATCH { status: "archived" }) is the safe alternative for
// those. See src/lib/supplier-delete.ts for exactly what's checked.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supplier = await getSupplier(id);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });

  const { eligible, reasons } = await checkSupplierDeleteEligibility(id);
  if (!eligible) {
    return NextResponse.json(
      { error: "This supplier has history and can't be permanently deleted. Archive it instead.", reasons },
      { status: 409 }
    );
  }

  await deleteSupplier(id);
  return NextResponse.json({ ok: true });
}
