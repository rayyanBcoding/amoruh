import { NextResponse } from "next/server";
import { getSupplier, updateSupplier } from "@/lib/intake-db";
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
  headerRowIndex?: number;
  headerSignature?: string[];
  columnMap?: SupplierColumnMapping["columnMap"];
  /** Retry a specific failed upload by id — see processSupplierUpload. */
  retryUploadId?: string;
}

// POST /api/pricing/process — applies EXACTLY the mapping the operator
// confirmed in Preview (headerRowIndex + headerSignature + columnMap).
// This route never detects or suggests anything itself — that only ever
// happens in /api/pricing/parse-preview. processSupplierUpload
// independently re-fetches the file and verifies the confirmed header
// row/signature still match, then re-runs the same sanity checks Preview
// showed, before writing anything — see its own comments for why.
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (
    !body.supplierId ||
    !body.blobUrl ||
    !body.uploadType ||
    body.headerRowIndex === undefined ||
    !body.headerSignature ||
    !body.columnMap
  ) {
    return NextResponse.json({ error: "Missing required fields — headerRowIndex, headerSignature, and columnMap must all be the exact configuration confirmed in Preview." }, { status: 400 });
  }

  const supplier = await getSupplier(body.supplierId);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });

  // Persist the confirmed triple as the remembered mapping — this IS
  // the same object being applied below, not a separate copy that could
  // drift from what actually gets processed.
  const confirmedMapping: SupplierColumnMapping = {
    headerRowIndex: body.headerRowIndex,
    headerSignature: body.headerSignature,
    columnMap: body.columnMap,
    confirmedAt: new Date().toISOString(),
  };
  const mappingChanged =
    !supplier.columnMapping ||
    supplier.columnMapping.headerRowIndex !== confirmedMapping.headerRowIndex ||
    JSON.stringify(supplier.columnMapping.headerSignature) !== JSON.stringify(confirmedMapping.headerSignature) ||
    JSON.stringify(supplier.columnMapping.columnMap) !== JSON.stringify(confirmedMapping.columnMap);
  if (mappingChanged || supplier.defaultUploadType !== body.uploadType) {
    await updateSupplier(supplier.id, { columnMapping: confirmedMapping, defaultUploadType: body.uploadType });
  }

  try {
    const upload = await processSupplierUpload({
      supplierId: supplier.id,
      filename: body.filename ?? "price-list",
      blobUrl: body.blobUrl,
      uploadType: body.uploadType,
      headerRowIndex: body.headerRowIndex,
      headerSignature: body.headerSignature,
      columnMap: body.columnMap,
      retryUploadId: body.retryUploadId,
    });
    return NextResponse.json(upload);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not process this upload." }, { status: 500 });
  }
}
