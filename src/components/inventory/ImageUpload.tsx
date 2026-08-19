"use client";

import { useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { BottleImage } from "@/components/BottleImage";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"];
const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8MB

export function ImageUpload({
  value,
  color,
  onChange,
}: {
  value: string;
  color?: string;
  onChange: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  // Revoke the object URL once it's no longer needed, to avoid leaking
  // memory across multiple uploads in one editing session.
  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  const handleFile = async (file: File) => {
    setError(null);

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError("Please choose a PNG, JPG, WEBP, GIF, or SVG image.");
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError(`That image is ${(file.size / 1024 / 1024).toFixed(1)}MB — max is 8MB.`);
      return;
    }

    // Show it immediately, before the upload round-trip finishes.
    const objectUrl = URL.createObjectURL(file);
    setLocalPreview(objectUrl);
    setUploading(true);

    try {
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/upload",
      });
      onChange(blob.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
      setLocalPreview(null);
    } finally {
      setUploading(false);
    }
  };

  const displaySrc = localPreview ?? value;

  return (
    <div className="space-y-3">
      <div className="relative">
        <BottleImage src={displaySrc} alt="Product" color={color} className="h-56" />
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-ld-bg/70">
            <span className="text-xs font-bold uppercase tracking-widest text-ld-muted">
              Uploading…
            </span>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex-1 rounded-lg border border-ld-border bg-ld-bg-elevated px-3 py-2 text-sm font-semibold text-ld-white hover:bg-ld-border/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading ? "Uploading…" : displaySrc ? "Replace Image" : "Upload Image"}
        </button>
        {displaySrc && !uploading && (
          <button
            type="button"
            onClick={() => {
              setLocalPreview(null);
              onChange("");
            }}
            className="rounded-lg border border-ld-red/30 bg-ld-red/10 px-3 py-2 text-sm font-semibold text-ld-red hover:bg-ld-red/15"
          >
            Remove
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = ""; // allow re-selecting the same file later
        }}
      />

      {error && <p className="text-xs font-semibold text-ld-red">{error}</p>}
    </div>
  );
}
