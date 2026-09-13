import { NextResponse } from "next/server";
import { getSuppliers, getOrCreateSupplier, updateSupplier } from "@/lib/intake-db";
import { isPossibleDuplicateSupplierName } from "@/lib/pricing-matching";
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
  /** Set once the operator has seen the possibleDuplicate warning below
   *  and chosen "Create New Supplier Anyway" — skips the check on retry. */
  confirmCreateAnyway?: boolean;
}

// POST /api/pricing/suppliers — create (or reuse, by exact name) a
// supplier, then apply any profile fields in one step.
//
// Before creating a genuinely NEW supplier (no exact case-insensitive
// name match — that path is unchanged, still silently reused), checks
// the name against every existing supplier for a likely duplicate (see
// isPossibleDuplicateSupplierName) and, if found, returns it instead of
// creating — never a silent merge. The UI shows "Possible existing
// supplier: X" with Use Existing / Create Anyway; the latter resubmits
// with confirmCreateAnyway. This is the exact gap that let "JIzan" and
// "Jizan Perfumes llc" become two unrelated supplier identities with
// zero shared history — see the Match Review audit.
export async function POST(req: Request) {
  let body: CreateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "Supplier name is required." }, { status: 400 });
  }

  const suppliers = await getSuppliers();
  const exactMatch = suppliers.some((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!exactMatch && !body.confirmCreateAnyway) {
    const possibleDuplicate = suppliers.find((s) => isPossibleDuplicateSupplierName(name, s.name));
    if (possibleDuplicate) {
      return NextResponse.json(
        { possibleDuplicate: { id: possibleDuplicate.id, name: possibleDuplicate.name } },
        { status: 409 }
      );
    }
  }

  const supplier = await getOrCreateSupplier(name);
  if (body.profile && Object.keys(body.profile).length > 0) {
    const updated = await updateSupplier(supplier.id, body.profile);
    return NextResponse.json(updated ?? supplier);
  }
  return NextResponse.json(supplier);
}
