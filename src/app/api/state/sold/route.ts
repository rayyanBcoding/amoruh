import { NextResponse } from "next/server";
import { buildSnapshot } from "@/lib/db";
import { broadcastStateChanged } from "@/lib/events";
import { markProductSold, SalesError } from "@/lib/sales-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  operator?: string;
  idempotencyKey: string;
}

// POST /api/state/sold — mark the current product sold. The actual
// write (inventory decrement, lot consumption, durable SaleRecord,
// aggregate update, recentSales) all happen as one atomic,
// version-checked operation in markProductSold() — see
// src/lib/sales-analytics.ts. This route is just the thin wrapper.
export async function POST(req: Request) {
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
    await markProductSold({ operator: body.operator || "Live Show", idempotencyKey: body.idempotencyKey });
    broadcastStateChanged("mark-sold");
    return NextResponse.json(await buildSnapshot());
  } catch (err) {
    const status = err instanceof SalesError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not mark sold." },
      { status }
    );
  }
}
