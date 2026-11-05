// TikTok IDs are 18–19 digit integers — beyond Number.MAX_SAFE_INTEGER (16
// digits), so a plain JSON.parse would silently corrupt them. Every TikTok ID in
// this integration is a STRING. TikTok normally already sends IDs as JSON
// strings, but we don't rely on that: before parsing, any bare integer literal
// with 16+ digits (outside a string) is quoted, so it round-trips exactly.

const LARGE_INT = /"(?:[^"\\]|\\.)*"|(-?\d{16,})(?![\d.eE])/g;

export function quoteLargeIntegers(text: string): string {
  return text.replace(LARGE_INT, (match, big: string | undefined) => (big ? `"${big}"` : match));
}

export function parseJsonPreservingIds<T = unknown>(text: string): T {
  return JSON.parse(quoteLargeIntegers(text)) as T;
}
