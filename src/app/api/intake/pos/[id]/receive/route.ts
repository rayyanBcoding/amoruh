import { NextResponse } from "next/server";
import { receiveAgainstLine, ReceivingError } from "@/lib/intake-receiving";

export const dynamic = "force-dynamic";

interface Body {
  poLineId: string;
  type: "received" | "modify" | "not_received";
  actualQty?: number;
  reason?: string;
  notes?: string;
  location?: string;
  method: "barcode" | "manual";
  operator: string;
  idempotencyKey: string;
}

// POST /api/intake/pos/[id]/receive — the single function every
// single-line receiving action funnels through, whether the operator
// got here by scanning a barcode or by picking the line manually from
// the PO. Same body shape, same backend logic, every time.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.poLineId || !body.type || !body.method || !body.idempotencyKey) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  try {
    const event = await receiveAgainstLine({
      poId: id,
      poLineId: body.poLineId,
      type: body.type,
      actualQty: body.actualQty,
      reason: body.reason,
      notes: body.notes,
      location: body.location,
      method: body.method,
      operator: body.operator || "Unknown",
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json({ event });
  } catch (err) {
    const status = err instanceof ReceivingError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not record this receiving action." },
      { status }
    );
  }
}
