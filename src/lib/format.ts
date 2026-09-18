/** Joins a brand and product name for display without repeating the
 *  brand when `name` already starts with it — confirmed as a real,
 *  live issue: many supplier descriptions restate the brand as their
 *  own leading word ("BURBERRY HER (W) EDT 100ML") even when a
 *  separate brand field/column also exists, so naively rendering
 *  `${brand} ${name}` everywhere produced "Burberry BURBERRY HER (W)
 *  EDT 100ML". Pure display formatting — never touches stored data,
 *  never risks creating a duplicate or changing an identity. */
export function formatProductTitle(brand: string, name: string): string {
  const trimmedBrand = brand.trim();
  const trimmedName = name.trim();
  if (!trimmedBrand) return trimmedName;
  if (trimmedName.toUpperCase().startsWith(trimmedBrand.toUpperCase())) return trimmedName;
  return `${trimmedBrand} ${trimmedName}`.trim();
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
