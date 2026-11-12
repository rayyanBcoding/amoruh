// Money from TikTok arrives as decimal STRINGS ("31", "4.89"). We store it exactly
// as a canonical decimal string and only convert to integer minor units (cents)
// by string arithmetic — never through a JS float — so profit maths later cannot
// drift. Returns null for anything that is not a plain decimal number.

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Canonical decimal string ("031" → "31", "4.50" → "4.50" kept as given digits) or null. */
export function normalizeMoney(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!DECIMAL.test(s)) return null;
  const neg = s.startsWith("-");
  const [int, frac] = (neg ? s.slice(1) : s).split(".");
  const intNorm = int.replace(/^0+(?=\d)/, "");
  return `${neg ? "-" : ""}${intNorm}${frac !== undefined ? "." + frac : ""}`;
}

/** Exact integer cents from a decimal string; more than 2 decimals is rejected (returns null). */
export function toCents(v: string | null): number | null {
  const s = normalizeMoney(v);
  if (s === null) return null;
  const neg = s.startsWith("-");
  const [int, frac = ""] = (neg ? s.slice(1) : s).split(".");
  if (frac.length > 2) return null;
  const cents = Number(int) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}
