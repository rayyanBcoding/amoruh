import clsx from "clsx";
import type { ProductStatus } from "@/lib/types";

const STATUS_STYLES: Record<ProductStatus, string> = {
  active: "bg-ld-green/15 text-ld-green ring-ld-green/40",
  draft: "bg-ld-amber/15 text-ld-amber ring-ld-amber/40",
  sold_out: "bg-ld-red/15 text-ld-red ring-ld-red/40",
  archived: "bg-white/10 text-ld-muted ring-white/20",
};

const STATUS_LABELS: Record<ProductStatus, string> = {
  active: "Active",
  draft: "Draft",
  sold_out: "Sold Out",
  archived: "Archived",
};

export function StatusBadge({ status }: { status: ProductStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ring-inset",
        STATUS_STYLES[status]
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function AuthenticBadge({ authentic }: { authentic: boolean }) {
  if (!authentic) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-ld-red/15 px-3 py-1 text-xs font-semibold text-ld-red ring-1 ring-inset ring-ld-red/40">
        Unverified
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ld-cyan/15 px-3 py-1 text-xs font-semibold text-ld-cyan ring-1 ring-inset ring-ld-cyan/40">
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
        <path
          fillRule="evenodd"
          d="M10 1.5l7 3.11v5.64c0 4.83-3 8.9-7 10.25-4-1.35-7-5.42-7-10.25V4.61l7-3.11zm-1.03 12.03l5.03-5.03-1.06-1.06-3.97 3.97-1.97-1.97-1.06 1.06 3.03 3.03z"
          clipRule="evenodd"
        />
      </svg>
      100% Authentic
    </span>
  );
}
