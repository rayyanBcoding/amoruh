import { NextResponse } from "next/server";
import { getPO } from "@/lib/intake-db";
import { checkPODeleteEligibility } from "@/lib/po-delete";

export const dynamic = "force-dynamic";

// GET /api/intake/pos/[id]/delete-eligibility — a preview for the UI
// only. The DELETE handler on the parent route re-runs this exact check
// itself immediately before deleting; it never trusts this result.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const po = await getPO(id);
  if (!po) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });

  const result = await checkPODeleteEligibility(id);
  return NextResponse.json(result);
}
