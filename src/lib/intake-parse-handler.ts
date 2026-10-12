import { NextResponse } from "next/server";
import { getProducts } from "./db";
import { matchLineItems } from "./intake-matching";
import { AI_NOT_CONFIGURED_FAILURE, classifyInvoiceExtractionError, type InvoiceExtractionFailure } from "./intake-ai-errors";
import type { ExtractedPO } from "./intake-types";
import type { Product } from "./types";

// The logic behind POST /api/intake/parse, with its two outside dependencies
// injectable so it can be tested without a funded AI account. The route file
// is a one-line wrapper using the real ones.
//
// This handler is a PREVIEW: it never writes. Nothing is persisted until the
// operator confirms the Review screen (POST /api/intake/pos).

export interface ParseDeps {
  extract: (pdfUrl: string, filename: string) => Promise<ExtractedPO>;
  loadProducts: () => Promise<Product[]>;
  apiKeyConfigured: () => boolean;
}

const realDeps: ParseDeps = {
  // Loaded lazily so importing this module never constructs the Anthropic client.
  extract: async (pdfUrl, filename) => (await import("./intake-parse")).extractPOFromInvoice(pdfUrl, filename),
  loadProducts: getProducts,
  apiKeyConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
};

function failureResponse(failure: InvoiceExtractionFailure) {
  return NextResponse.json(
    { error: failure.userMessage, code: failure.code, retryable: failure.retryable, noInventoryChanged: true },
    { status: failure.httpStatus }
  );
}

export async function handleParseInvoice(req: Request, deps: ParseDeps = realDeps): Promise<Response> {
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

  if (!deps.apiKeyConfigured()) {
    return failureResponse(AI_NOT_CONFIGURED_FAILURE);
  }

  try {
    const extracted = await deps.extract(blobUrl, filename ?? "invoice.pdf");
    const products = await deps.loadProducts();
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
