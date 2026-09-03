import { NextResponse } from "next/server";
import { createPOFromReview, getPOs } from "@/lib/intake-db";
import type { ExtractedPO, MatchedLineItem } from "@/lib/intake-types";

export const dynamic = "force-dynamic";

export async function GET() {
  const pos = await getPOs();
  // Newest first — matches the PO Dashboard's expected order.
  const sorted = [...pos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return NextResponse.json({ pos: sorted });
}

interface CreatePOBody {
  extracted: ExtractedPO;
  lines: MatchedLineItem[];
  resolvedProductIds: (string | null)[];
  blobUrl: string;
  filename: string;
}

export async function POST(req: Request) {
  let body: CreatePOBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.extracted || !Array.isArray(body.lines) || !Array.isArray(body.resolvedProductIds) || !body.blobUrl) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }
  if (body.lines.length !== body.resolvedProductIds.length) {
    return NextResponse.json({ error: "resolvedProductIds must have one entry per line." }, { status: 400 });
  }

  try {
    const po = await createPOFromReview({
      extracted: body.extracted,
      lines: body.lines,
      resolvedProductIds: body.resolvedProductIds,
      blobUrl: body.blobUrl,
      filename: body.filename ?? "invoice.pdf",
    });
    return NextResponse.json({ po }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not create the purchase order." },
      { status: 400 }
    );
  }
}
