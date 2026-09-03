import { NextResponse } from "next/server";
import { getPO, getPOLines, getInvoiceDocument, recomputePOFromLines, savePOLines, updatePOStatus } from "@/lib/intake-db";
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

  const updated = await recomputePOFromLines(id);
  return NextResponse.json({ po: updated });
}
