import { NextResponse } from "next/server";
import { getProducts } from "@/lib/db";
import { extractPOFromInvoice } from "@/lib/intake-parse";
import { matchLineItems } from "@/lib/intake-matching";
import { AI_NOT_CONFIGURED_FAILURE, classifyInvoiceExtractionError, type InvoiceExtractionFailure } from "@/lib/intake-ai-errors";

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
    return failureResponse(AI_NOT_CONFIGURED_FAILURE);
  }

  try {
    const extracted = await extractPOFromInvoice(blobUrl, filename ?? "invoice.pdf");
    const products = await getProducts();
    const matched = matchLineItems(extracted.lineItems, products);

    return NextResponse.json({ extracted, matched });
  } catch (err) {
    // Raw provider detail goes to the server log only; the browser gets a
    // short, safe message. Nothing was written before this point, so every
    // failure here leaves inventory and POs untouched.
    const failure = classifyInvoiceExtractionError(err);
    console.error("[intake/parse] invoice extraction failed", { code: failure.code, ...failure.logDetail });
    return failureResponse(failure);
  }
}

function failureResponse(failure: InvoiceExtractionFailure) {
  return NextResponse.json(
    { error: failure.userMessage, code: failure.code, retryable: failure.retryable, noInventoryChanged: true },
    { status: failure.httpStatus }
  );
}
