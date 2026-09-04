"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScanResolution } from "@/lib/intake-types";

/**
 * Barcode input for the Receiving screen. Same focus-management pattern
 * as src/components/BarcodeScanner.tsx (always-focused input + a global
 * keydown fallback buffer) — but resolves against a PO's lines instead
 * of the live-show product list, and reports the result up rather than
 * mutating anything itself. Receiving must never depend on scanning
 * being available — see the manual "Confirm Received" path on the line
 * list for the alternative.
 */
export function ReceivingScanner({
  poId,
  onResolved,
  disabled,
}: {
  poId: string;
  onResolved: (resolution: ScanResolution, code: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const globalBufferRef = useRef("");
  const globalBufferTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const submit = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/intake/pos/${poId}/scan?code=${encodeURIComponent(trimmed)}`);
        const resolution = await res.json();
        onResolved(resolution, trimmed);
      } finally {
        setValue("");
        setBusy(false);
      }
    },
    [poId, onResolved, busy]
  );

  useEffect(() => {
    if (disabled) return;
    const refocus = () => {
      const active = document.activeElement;
      const isTypingElsewhere =
        active instanceof HTMLElement &&
        active !== inputRef.current &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (!isTypingElsewhere) {
        inputRef.current?.focus({ preventScroll: true });
      }
    };
    refocus();
    const interval = setInterval(refocus, 1200);
    return () => clearInterval(interval);
  }, [disabled]);

  useEffect(() => {
    if (disabled) return;
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const alreadyTypingInField =
        active instanceof HTMLElement &&
        active !== inputRef.current &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (alreadyTypingInField) return;

      if (e.key === "Enter") {
        if (globalBufferRef.current.length >= 3) {
          void submit(globalBufferRef.current);
        }
        globalBufferRef.current = "";
        return;
      }
      if (e.key.length === 1) {
        globalBufferRef.current += e.key;
        if (globalBufferTimer.current) clearTimeout(globalBufferTimer.current);
        globalBufferTimer.current = setTimeout(() => {
          globalBufferRef.current = "";
        }, 400);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [submit, disabled]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(value);
      }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Scan a barcode…"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled || busy}
        className="w-full rounded-xl border-2 border-ld-border bg-ld-bg-elevated px-5 py-4 font-mono text-lg tracking-wider text-ld-white placeholder:text-ld-muted/60 outline-none transition-colors focus:border-ld-purple focus:ring-4 focus:ring-ld-purple/15 disabled:opacity-50"
      />
    </form>
  );
}
