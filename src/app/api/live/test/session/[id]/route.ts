import { NextResponse } from "next/server";
import { getProduct } from "@/lib/db";
import { deleteTestSession, getPresentationsForTestSession, getTestSession, getTestSessionStats } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/live/test/session/{id} — Test Session Summary, mirroring
// /api/live/session/{id}.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getTestSession(id);
    if (!session) {
      return NextResponse.json({ error: "Test Live session not found." }, { status: 404 });
    }

    const [stats, views] = await Promise.all([getTestSessionStats(id), getPresentationsForTestSession(id, 5000)]);

    const productIds = Array.from(new Set(views.map((v) => v.presentation.productId)));
    const products = await Promise.all(productIds.map((pid) => getProduct(pid)));
    const productById = new Map(products.filter((p) => p !== null).map((p) => [p!.id, p!]));

    const items = views.map((v) => ({
      presentation: v.presentation,
      sale: v.sale,
      product: productById.get(v.presentation.productId) ?? null,
    }));

    return NextResponse.json({ session, stats, items });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load this Test Live session: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

// DELETE /api/live/test/session/{id} — the explicit "DELETE TEST
// SESSION" cleanup action, and also what "Retry Delete Test Session"
// calls after a failed Discard. Safe to call more than once.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteTestSession(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not delete this Test Live session." },
      { status: 400 }
    );
  }
}
