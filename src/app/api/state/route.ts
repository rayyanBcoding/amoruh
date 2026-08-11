import { NextResponse } from "next/server";
import { buildSnapshot } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/state — current fully-hydrated live snapshot.
export async function GET() {
  const snapshot = await buildSnapshot();
  return NextResponse.json(snapshot);
}
