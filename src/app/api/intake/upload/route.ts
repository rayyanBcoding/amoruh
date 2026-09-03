import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mirrors /api/upload (product images) exactly, but scoped to PDFs so the
// two upload flows stay independent — see the Development Process note in
// the Inventory Intake Mode plan.
const ALLOWED_TYPES = ["application/pdf"];
const MAX_SIZE_BYTES = 32 * 1024 * 1024; // 32MB — matches Claude's PDF request-size limit

export async function POST(req: Request) {
  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_TYPES,
        maximumSizeInBytes: MAX_SIZE_BYTES,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {
        // No DB write here — the client calls /api/intake/parse next with
        // the returned blob URL.
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed." },
      { status: 400 }
    );
  }
}
