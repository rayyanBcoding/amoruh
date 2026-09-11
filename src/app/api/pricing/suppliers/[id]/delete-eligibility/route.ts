import { NextResponse } from "next/server";
import { getSupplier } from "@/lib/intake-db";
import { checkSupplierDeleteEligibility } from "@/lib/supplier-delete";

export const dynamic = "force-dynamic";

// GET /api/pricing/suppliers/[id]/delete-eligibility — a preview for the
// UI only. The DELETE handler on the parent route re-runs this exact
// check itself immediately before deleting; it never trusts this result.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supplier = await getSupplier(id);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });

  const result = await checkSupplierDeleteEligibility(id);
  return NextResponse.json(result);
}
