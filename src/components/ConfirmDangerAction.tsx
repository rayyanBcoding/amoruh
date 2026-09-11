"use client";

import { useState } from "react";
import { Button } from "@/components/Button";

interface ConfirmDangerActionProps {
  /** Rendered on the initial button. */
  label: string;
  /** Exact confirmation copy, e.g. `Permanently delete supplier "X"? This cannot be undone.` */
  confirmMessage: string;
  /** If given, the reasons this action is currently blocked — renders a
   *  warning panel instead of any confirm affordance, and the action can
   *  never be triggered. */
  blockedReasons?: string[];
  /** Shown alongside blockedReasons as the safe alternative, e.g. "Archive Supplier". */
  blockedAlternativeLabel?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}

/** A two-step "danger zone" confirm — first click reveals the warning +
 *  a second explicit confirm button, never a single window.confirm.
 *  Shared between Supplier and PO permanent-delete actions. When
 *  blockedReasons is non-empty, no delete affordance is ever offered —
 *  only the reasons and (optionally) a pointer at the safe alternative. */
export function ConfirmDangerAction({
  label,
  confirmMessage,
  blockedReasons,
  blockedAlternativeLabel,
  onConfirm,
  disabled,
}: ConfirmDangerActionProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (blockedReasons && blockedReasons.length > 0) {
    return (
      <div className="rounded-xl border border-ld-amber/30 bg-ld-amber/10 p-4 text-sm text-ld-amber">
        <p className="mb-2 font-semibold">Can&apos;t permanently delete — history exists:</p>
        <ul className="mb-2 list-inside list-disc space-y-1">
          {blockedReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {blockedAlternativeLabel && <p className="text-ld-muted">Use &ldquo;{blockedAlternativeLabel}&rdquo; instead.</p>}
      </div>
    );
  }

  if (!confirming) {
    return (
      <Button variant="danger" size="md" disabled={disabled} onClick={() => setConfirming(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="rounded-xl border border-ld-red/30 bg-ld-red/5 p-4">
      <p className="mb-3 text-sm font-semibold text-ld-red">{confirmMessage}</p>
      <div className="flex gap-3">
        <Button
          variant="danger"
          size="md"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Yes, delete permanently"}
        </Button>
        <Button variant="ghost" size="md" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
