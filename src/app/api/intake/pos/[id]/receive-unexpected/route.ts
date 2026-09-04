import { NextResponse } from "next/server";
import { receiveUnexpectedItem, ReceivingError } from "@/lib/intake-receiving";

export const dynamic = "force-dynamic";

interface Body {
  productId: string;
  quantity: number;
  cost: number;
  reason: string;
  method: "barcode" | "manual";
  operator: string;
  idempotencyKey: string;
}

// POST /api/intake/pos/[id]/receive-unexpected — §14: a product exists
// in AMORUH but wasn't on this PO's invoice.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.productId || !body.idempotencyKey) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  try {
    const event = await receiveUnexpectedItem({
      poId: id,
      productId: body.productId,
      quantity: body.quantity,
      cost: body.cost,
      reason: body.reason,
      method: body.method,
      operator: body.operator || "Unknown",
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json({ event });
  } catch (err) {
    const status = err instanceof ReceivingError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not record this item." },
      { status }
    );
  }
}
