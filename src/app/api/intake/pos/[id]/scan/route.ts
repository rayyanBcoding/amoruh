import { NextResponse } from "next/server";
import { resolvePOScan } from "@/lib/intake-receiving";

export const dynamic = "force-dynamic";

// GET /api/intake/pos/[id]/scan?code=XXXX — resolves a scanned barcode
// (or typed SKU) against this PO's lines. Read-only.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const code = new URL(req.url).searchParams.get("code");
  if (!code) {
    return NextResponse.json({ error: "Missing code." }, { status: 400 });
  }

  const resolution = await resolvePOScan(id, code);
  return NextResponse.json(resolution);
}
