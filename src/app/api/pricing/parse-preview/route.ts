import { NextResponse } from "next/server";
import { getSupplier } from "@/lib/intake-db";
import { computeHeaderSignature, parseSpreadsheet, signatureMatches, suggestColumnMapping } from "@/lib/pricing-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  supplierId?: string;
  blobUrl?: string;
}

// POST /api/pricing/parse-preview — fetches the just-uploaded blob,
// parses it deterministically (no Claude call — this is structured
// tabular data), and checks whether the supplier's remembered column
// mapping still applies. If it does, the operator can skip straight to
// processing; if not (new supplier, or the layout materially changed),
// this returns the raw headers + a best-guess mapping for confirmation.
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.supplierId || !body.blobUrl) {
    return NextResponse.json({ error: "Missing supplierId or blobUrl." }, { status: 400 });
  }

  const [supplier, blobRes] = await Promise.all([getSupplier(body.supplierId), fetch(body.blobUrl)]);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
  if (!blobRes.ok) return NextResponse.json({ error: "Could not download the uploaded file." }, { status: 400 });

  let sheet;
  try {
    const buffer = await blobRes.arrayBuffer();
    sheet = parseSpreadsheet(buffer);
  } catch {
    return NextResponse.json({ error: "Could not read this file — is it a valid Excel or CSV file?" }, { status: 400 });
  }
  if (sheet.rows.length === 0) {
    return NextResponse.json({ error: "This file has no data rows." }, { status: 400 });
  }

  const signature = computeHeaderSignature(sheet.headers);
  const stored = supplier.columnMapping;
  if (stored && signatureMatches(stored.headerSignature, signature)) {
    return NextResponse.json({
      mappingReused: true,
      columnMap: stored.columnMap,
      headers: sheet.headers,
      rowCount: sheet.rows.length,
      defaultUploadType: supplier.defaultUploadType ?? "full",
    });
  }

  return NextResponse.json({
    mappingReused: false,
    headers: sheet.headers,
    suggestedColumnMap: suggestColumnMapping(sheet.headers),
    rowCount: sheet.rows.length,
    defaultUploadType: supplier.defaultUploadType ?? "full",
  });
}
