import { NextResponse } from "next/server";
import { getProducts } from "@/lib/db";
import { extractPOFromInvoice } from "@/lib/intake-parse";
import { matchLineItems } from "@/lib/intake-matching";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/intake/parse — takes a blob URL just uploaded via
// /api/intake/upload, extracts a structured PO from it with Claude, and
// runs product matching. Returns a preview only — nothing is persisted
// until the operator confirms on the Review screen (POST /api/intake/pos).
export async function POST(req: Request) {
  let body: { blobUrl?: string; filename?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { blobUrl, filename } = body;
  if (!blobUrl || typeof blobUrl !== "string") {
    return NextResponse.json({ error: "Missing blobUrl." }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY isn't set on this deployment yet — add it in Vercel project settings to enable invoice parsing." },
      { status: 500 }
    );
  }

  try {
    const extracted = await extractPOFromInvoice(blobUrl, filename ?? "invoice.pdf");
    const products = await getProducts();
    const matched = matchLineItems(extracted.lineItems, products);

    return NextResponse.json({ extracted, matched });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not parse this invoice." },
      { status: 500 }
    );
  }
}
