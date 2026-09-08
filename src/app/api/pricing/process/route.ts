import { NextResponse } from "next/server";
import { getSupplier, updateSupplier } from "@/lib/intake-db";
import { computeHeaderSignature, parseSpreadsheet } from "@/lib/pricing-parse";
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
// column mapping and an upload type. Remembers the mapping on the
// supplier if it's new or changed, then hands off to
// processSupplierUpload, which creates the upload record FIRST and only
// then fetches/parses the file itself — so a failure at any point
// (can't download the blob, can't parse it, a bad row) always leaves a
// real, visible "failed" record, never a bare HTTP error with no trace.
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

  // Only needs the header row to decide whether to remember a new
  // mapping — the full row-by-row fetch/parse for staging happens
  // inside processSupplierUpload, after the upload record already
  // exists.
  try {
    const blobRes = await fetch(body.blobUrl);
    if (blobRes.ok) {
      const sheet = parseSpreadsheet(await blobRes.arrayBuffer());
      const signature = computeHeaderSignature(sheet.headers);
      const mappingChanged =
        !supplier.columnMapping ||
        JSON.stringify(supplier.columnMapping.headerSignature) !== JSON.stringify(signature) ||
        JSON.stringify(supplier.columnMapping.columnMap) !== JSON.stringify(body.columnMap);
      if (mappingChanged || supplier.defaultUploadType !== body.uploadType) {
        await updateSupplier(supplier.id, {
          columnMapping: { headerSignature: signature, columnMap: body.columnMap, confirmedAt: new Date().toISOString() },
          defaultUploadType: body.uploadType,
        });
      }
    }
    // If the blob can't be fetched here, don't fail the request over a
    // mapping-memory nicety — processSupplierUpload will hit the exact
    // same fetch next and surface the real error as a proper failed
    // upload record.
  } catch {
    // Same reasoning — let processSupplierUpload be the source of truth
    // for whether this upload actually succeeds or fails.
  }

  try {
    const upload = await processSupplierUpload({
      supplierId: supplier.id,
      filename: body.filename ?? "price-list",
      blobUrl: body.blobUrl,
      uploadType: body.uploadType,
      columnMap: body.columnMap,
      retryUploadId: body.retryUploadId,
    });
    return NextResponse.json(upload);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not process this upload." }, { status: 500 });
  }
}
