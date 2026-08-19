"use client";

import { useState } from "react";
import clsx from "clsx";

function Placeholder({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 200"
      className={clsx("h-full max-h-full w-auto opacity-40", className)}
      fill="none"
    >
      <rect x="35" y="10" width="26" height="24" rx="4" stroke="currentColor" strokeWidth="3" />
      <path
        d="M40 34 h20 a10 10 0 0 1 10 10 v130 a16 16 0 0 1 -16 16 H46 a16 16 0 0 1 -16 -16 V44 a10 10 0 0 1 10 -10 Z"
        stroke="currentColor"
        strokeWidth="3"
      />
      <line x1="30" y1="95" x2="90" y2="95" stroke="currentColor" strokeWidth="3" strokeDasharray="4 6" />
    </svg>
  );
}

export function BottleImage({
  src,
  alt,
  color,
  className,
  glow = true,
}: {
  src: string;
  alt: string;
  color?: string;
  className?: string;
  glow?: boolean;
}) {
  // Track *which* src failed rather than a plain boolean, so a changed src
  // (e.g. a different product) naturally clears the failure without an
  // effect to reset it.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPlaceholder = !src || failedSrc === src;

  return (
    <div className={clsx("relative flex items-center justify-center", className)}>
      {glow && !showPlaceholder && (
        <div
          className="absolute inset-0 -z-10 rounded-full blur-3xl opacity-[0.14]"
          style={{ background: color ?? "#B89A5C" }}
        />
      )}
      {showPlaceholder ? (
        <Placeholder className="text-ld-muted" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          className="h-full max-h-full w-auto drop-shadow-[0_12px_20px_rgba(47,46,34,0.18)]"
          draggable={false}
          onError={() => setFailedSrc(src)}
        />
      )}
    </div>
  );
}
