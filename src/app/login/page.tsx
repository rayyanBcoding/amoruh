"use client";

import { Suspense, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "@/components/Logo";

function PasscodeForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/dashboard";

  const [digits, setDigits] = useState(["", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const submit = async (code: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Incorrect passcode.");
        setDigits(["", "", "", ""]);
        inputRefs.current[0]?.focus();
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const setDigit = (index: number, value: string) => {
    const clean = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = clean;
    setDigits(next);

    if (clean && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }
    if (clean && index === 3 && next.every((d) => d !== "")) {
      void submit(next.join(""));
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  return (
    <div className="glass-panel w-full max-w-sm rounded-2xl p-8 text-center">
      <div className="mb-1 flex justify-center">
        <Logo size="md" href={null} />
      </div>
      <p className="mb-6 text-sm text-ld-muted">Enter the 4-digit passcode to continue.</p>

      <div className="mb-4 flex justify-center gap-3">
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            disabled={submitting}
            onChange={(e) => setDigit(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            autoFocus={i === 0}
            className="h-14 w-12 rounded-xl border-2 border-ld-border bg-ld-bg-elevated text-center font-display text-2xl font-bold text-ld-white outline-none transition-colors focus:border-ld-purple focus:ring-4 focus:ring-ld-purple/15"
          />
        ))}
      </div>

      {error && <p className="text-sm font-semibold text-ld-red">{error}</p>}
      {submitting && <p className="text-sm text-ld-muted">Checking…</p>}
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Suspense fallback={null}>
        <PasscodeForm />
      </Suspense>
    </div>
  );
}
