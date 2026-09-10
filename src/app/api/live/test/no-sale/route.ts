import { NextResponse } from "next/server";
import { getActiveTestSession, recordTestNoSale } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/live/test/no-sale { productId, operator?, idempotencyKey } —
// mirrors /api/live/no-sale. Never touches inventory, real or simulated.
export async function POST(req: Request) {
  let body: { productId?: string; operator?: string; idempotencyKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.idempotencyKey) return NextResponse.json({ error: "Missing idempotencyKey." }, { status: 400 });
  if (typeof body.productId !== "string" || !body.productId) return NextResponse.json({ error: "Missing productId." }, { status: 400 });

  try {
    const session = await getActiveTestSession();
    if (!session || session.status !== "active") {
      return NextResponse.json({ error: "No active Test Live." }, { status: 400 });
    }

    const result = await recordTestNoSale({
      sessionId: session.id,
      productId: body.productId,
      operator: body.operator || "Test Rehearsal",
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not record Test No Sale." },
      { status: 500 }
    );
  }
}
