"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLiveState } from "@/context/LiveStateContext";

/**
 * Barcode input for the Operator Dashboard.
 *
 * V1 assumption: barcode scanners act as keyboards — they "type" the code
 * fast and send Enter/Tab. This component keeps a visible, always-focused
 * input for that, and a global fallback listener that catches a scan even
 * if the operator's cursor has wandered onto another field or button.
 */
export function BarcodeScanner() {
  const { scanBarcode } = useLiveState();
  const [value, setValue] = useState("");
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [notFoundCode, setNotFoundCode] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const globalBufferRef = useRef("");
  const globalBufferTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const submit = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      const result = await scanBarcode(trimmed);
      setNotFoundCode(null);
      if (result.ok) {
        setFeedback({ type: "ok", text: `Scanned ${trimmed} ✓` });
      } else {
        setFeedback({ type: "err", text: result.error ?? `"${trimmed}" not found` });
        if (result.notFound) setNotFoundCode(trimmed);
      }
      setValue("");
      // Keep a "not found" message (with the Add Product link) up longer
      // than a normal success/error flash — the operator needs time to
      // read it and click through.
      window.setTimeout(() => setFeedback(null), result.notFound ? 8000 : 2500);
    },
    [scanBarcode]
  );

  // Keep the dedicated field focused whenever nothing else needs focus, so
  // a physical scanner "just works" without the operator clicking first.
  useEffect(() => {
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
  }, []);

  // Global fallback: capture fast keystroke bursts anywhere on the page
  // (mimics a hardware scanner) and treat a trailing Enter as a scan.
  useEffect(() => {
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
  }, [submit]);

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-ld-muted">
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-ld-purple">
          <path
            d="M3 5v14M7 5v14M10 5v14M13 5v14h2V5M18 5v14M21 5v14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        Barcode Scanner Input
      </label>
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
          placeholder="Scan SKU barcode… (e.g. LD000101)"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-xl border-2 border-ld-border bg-ld-bg-elevated px-5 py-4 font-mono text-lg tracking-wider text-ld-white placeholder:text-ld-muted/60 outline-none transition-colors focus:border-ld-purple focus:ring-4 focus:ring-ld-purple/15"
        />
      </form>
      {feedback && (
        <div className="flex flex-wrap items-center gap-3">
          <p
            className={
              feedback.type === "ok"
                ? "text-sm font-semibold text-ld-green"
                : "text-sm font-semibold text-ld-red"
            }
          >
            {feedback.text}
          </p>
          {notFoundCode && (
            <Link
              href={`/inventory/new?barcode=${encodeURIComponent(notFoundCode)}`}
              className="rounded-lg bg-ld-purple/15 px-3 py-1 text-sm font-bold text-ld-purple hover:bg-ld-purple/25"
            >
              + Add Product with this code
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
