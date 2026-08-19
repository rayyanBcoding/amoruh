import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"];
const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8MB — plenty for a bottle photo

// POST /api/upload — backs the client-direct-upload flow for product
// images (see ProductEditorForm). The browser uploads the file bytes
// straight to Vercel Blob storage; this route only ever issues a
// short-lived, scoped upload token — the file itself never passes through
// a serverless function body (which has a small size limit).
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
        // No DB write needed here — the client sets the returned blob URL
        // on the product itself via the normal PUT/POST product save.
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
