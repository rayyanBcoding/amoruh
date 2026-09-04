import { NextResponse } from "next/server";
import { receiveAll, ReceivingError } from "@/lib/intake-receiving";

export const dynamic = "force-dynamic";

interface Body {
  operator: string;
  idempotencyKey: string;
}

// POST /api/intake/pos/[id]/receive-all — §6: everything currently
// outstanding on this PO physically arrived exactly as expected. Blocked
// entirely if any line is still unmatched to a product; runs as one
// atomic batch under one shared idempotency key otherwise.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.idempotencyKey) {
    return NextResponse.json({ error: "Missing idempotencyKey." }, { status: 400 });
  }

  try {
    const result = await receiveAll({
      poId: id,
      operator: body.operator || "Unknown",
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof ReceivingError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not receive all remaining inventory." },
      { status }
    );
  }
}
