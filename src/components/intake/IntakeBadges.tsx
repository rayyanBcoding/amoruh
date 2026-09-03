import clsx from "clsx";
import type { MatchType, POLineStatus, POStatus } from "@/lib/intake-types";

const PO_STATUS_STYLES: Record<POStatus, string> = {
  awaiting_delivery: "bg-ld-amber/15 text-ld-amber ring-ld-amber/40",
  partially_received: "bg-ld-cyan/15 text-ld-cyan ring-ld-cyan/40",
  received: "bg-ld-green/15 text-ld-green ring-ld-green/40",
  closed: "bg-ld-border/40 text-ld-muted ring-ld-border",
};

const PO_STATUS_LABELS: Record<POStatus, string> = {
  awaiting_delivery: "Awaiting Delivery",
  partially_received: "Partially Received",
  received: "Received",
  closed: "Closed",
};

export function POStatusBadge({ status }: { status: POStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ring-inset",
        PO_STATUS_STYLES[status]
      )}
    >
      {PO_STATUS_LABELS[status]}
    </span>
  );
}

const LINE_STATUS_STYLES: Record<POLineStatus, string> = {
  pending: "bg-ld-border/40 text-ld-muted ring-ld-border",
  matched: "bg-ld-cyan/15 text-ld-cyan ring-ld-cyan/40",
  received: "bg-ld-green/15 text-ld-green ring-ld-green/40",
  partial: "bg-ld-amber/15 text-ld-amber ring-ld-amber/40",
  missing: "bg-ld-red/15 text-ld-red ring-ld-red/40",
  overage: "bg-ld-purple/15 text-ld-purple ring-ld-purple/40",
  damaged: "bg-ld-red/15 text-ld-red ring-ld-red/40",
};

const LINE_STATUS_LABELS: Record<POLineStatus, string> = {
  pending: "Pending",
  matched: "Matched",
  received: "Received",
  partial: "Partial",
  missing: "Missing",
  overage: "Overage",
  damaged: "Damaged",
};

export function LineStatusBadge({ status }: { status: POLineStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset",
        LINE_STATUS_STYLES[status]
      )}
    >
      {LINE_STATUS_LABELS[status]}
    </span>
  );
}

const MATCH_STYLES: Record<MatchType, string> = {
  upc: "bg-ld-green/15 text-ld-green ring-ld-green/40",
  sku: "bg-ld-green/15 text-ld-green ring-ld-green/40",
  fuzzy: "bg-ld-amber/15 text-ld-amber ring-ld-amber/40",
  unmatched: "bg-ld-red/15 text-ld-red ring-ld-red/40",
};

const MATCH_LABELS: Record<MatchType, string> = {
  upc: "UPC Match",
  sku: "SKU Match",
  fuzzy: "Possible Match",
  unmatched: "No Match",
};

export function MatchBadge({ type, confidence }: { type: MatchType; confidence?: number | null }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset",
        MATCH_STYLES[type]
      )}
    >
      {MATCH_LABELS[type]}
      {type === "fuzzy" && confidence != null && ` · ${Math.round(confidence * 100)}%`}
    </span>
  );
}
