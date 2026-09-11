import { NextResponse } from "next/server";
import {
  getPO,
  getPOLines,
  getInvoiceDocument,
  recomputePOFromLines,
  savePOLines,
  updatePOStatus,
  updatePOShippingCost,
  deletePO,
} from "@/lib/intake-db";
import { checkPODeleteEligibility } from "@/lib/po-delete";
import type { POStatus } from "@/lib/intake-types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const po = await getPO(id);
  if (!po) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });

  const lines = await getPOLines(id);
  const document = po.invoiceDocumentId ? await getInvoiceDocument(po.invoiceDocumentId) : null;

  return NextResponse.json({ po, lines, document });
}

interface PatchBody {
  status?: POStatus;
  /** Resolve a still-unmatched line to a product from the PO Detail screen. */
  lineId?: string;
  productId?: string | null;
  shippingCost?: number;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const po = await getPO(id);
  if (!po) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });

  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (body.lineId) {
    const lines = await getPOLines(id);
    const idx = lines.findIndex((l) => l.id === body.lineId);
    if (idx === -1) return NextResponse.json({ error: "Line not found." }, { status: 404 });
    lines[idx] = {
      ...lines[idx],
      productId: body.productId ?? null,
      matchType: body.productId ? "manual" : "unmatched",
    };
    await savePOLines(id, lines);
  }

  if (body.status) {
    await updatePOStatus(id, body.status);
  }

  if (typeof body.shippingCost === "number") {
    if (!Number.isFinite(body.shippingCost) || body.shippingCost < 0) {
      return NextResponse.json({ error: "Shipping cost must be a non-negative number." }, { status: 400 });
    }
    await updatePOShippingCost(id, body.shippingCost);
  }

  const updated = await recomputePOFromLines(id);
  return NextResponse.json({ po: updated });
}

// DELETE /api/intake/pos/[id] — hard delete. Re-runs the exact same
// eligibility check the GET .../delete-eligibility route offers as a
// preview — never trusts that a client-side confirm already checked it.
// Blocked (409, with reasons) whenever the PO has ANY receiving history;
// Cancel PO (PATCH { status: "canceled" }) is the safe alternative for
// those. See src/lib/po-delete.ts for exactly what's checked.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const po = await getPO(id);
  if (!po) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });

  const { eligible, reasons } = await checkPODeleteEligibility(id);
  if (!eligible) {
    return NextResponse.json(
      { error: "This PO has receiving history and can't be permanently deleted. Cancel it instead.", reasons },
      { status: 409 }
    );
  }

  await deletePO(id);
  return NextResponse.json({ ok: true });
}
