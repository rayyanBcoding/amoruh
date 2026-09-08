import { NextResponse } from "next/server";
import { getSupplier, updateSupplier } from "@/lib/intake-db";
import { applyColumnMapping, computeHeaderSignature, parseSpreadsheet } from "@/lib/pricing-parse";
import { processSupplierUpload } from "@/lib/pricing-process";
import type { SupplierColumnMapping } from "@/lib/intake-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  supplierId?: string;
  blobUrl?: string;
  filename?: string;
  uploadType?: "full" | "partial";
  columnMap?: SupplierColumnMapping["columnMap"];
  /** Retry a specific failed upload by id — see processSupplierUpload. */
  retryUploadId?: string;
}

// POST /api/pricing/process — the operator has confirmed (or reused) a
// column mapping and an upload type; this re-fetches the file (avoids
// round-tripping potentially thousands of rows back and forth over
// HTTP), applies the mapping, remembers it on the supplier if it's new
// or changed, and runs the full stage-then-commit pipeline.
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.supplierId || !body.blobUrl || !body.uploadType || !body.columnMap) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  const supplier = await getSupplier(body.supplierId);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });

  const blobRes = await fetch(body.blobUrl);
  if (!blobRes.ok) return NextResponse.json({ error: "Could not download the uploaded file." }, { status: 400 });

  let sheet;
  try {
    sheet = parseSpreadsheet(await blobRes.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Could not read this file." }, { status: 400 });
  }
  if (sheet.rows.length === 0) {
    return NextResponse.json({ error: "This file has no data rows." }, { status: 400 });
  }

  const signature = computeHeaderSignature(sheet.headers);
  const mappingChanged =
    !supplier.columnMapping || JSON.stringify(supplier.columnMapping.headerSignature) !== JSON.stringify(signature) ||
    JSON.stringify(supplier.columnMapping.columnMap) !== JSON.stringify(body.columnMap);

  if (mappingChanged || supplier.defaultUploadType !== body.uploadType) {
    await updateSupplier(supplier.id, {
      columnMapping: { headerSignature: signature, columnMap: body.columnMap, confirmedAt: new Date().toISOString() },
      defaultUploadType: body.uploadType,
    });
  }

  const rows = applyColumnMapping(sheet.rows, body.columnMap);

  try {
    const upload = await processSupplierUpload({
      supplierId: supplier.id,
      filename: body.filename ?? "price-list",
      blobUrl: body.blobUrl,
      uploadType: body.uploadType,
      rows,
      retryUploadId: body.retryUploadId,
    });
    return NextResponse.json(upload);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not process this upload." }, { status: 500 });
  }
}
