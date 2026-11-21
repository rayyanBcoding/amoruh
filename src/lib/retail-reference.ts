import type { Product } from "./types";

export interface RetailReference {
  status: "verified" | "not_verified";
  priceCents: number | null;
  currency: "USD";
  referenceSize: string | null;
  concentration: string;
  retailer: string | null;
  sourceUrl: string | null;
  checkedAt: string;
  identityKey: string;
  manuallyEdited: boolean;
  verificationNotes: string;
}

export type RetailIdentity = Pick<Product, "brand" | "name" | "concentration" | "size" | "condition" | "barcode" | "sku">;
export function retailIdentity(p: RetailIdentity): string {
  return JSON.stringify([p.brand, p.name, p.concentration, p.size, p.condition, p.barcode, p.sku]);
}
const RETAILERS: Record<string, string[]> = {
  Sephora: ["sephora.com"], Ulta: ["ulta.com"], Nordstrom: ["nordstrom.com"],
  "Neiman Marcus": ["neimanmarcus.com"], "Bloomingdale’s": ["bloomingdales.com"],
  "Macy’s": ["macys.com"], "Saks Fifth Avenue": ["saksfifthavenue.com"],
};
// Explicit brand-owned domains only; no general "official" escape hatch.
const BRANDS: Record<string, string[]> = {
  "afnan": ["afnan.com"], "burberry": ["burberry.com"], "coach": ["coach.com"],
  "carolina herrera": ["carolinaherrera.com"], "dolce & gabbana": ["dolcegabbana.com"],
  "givenchy": ["givenchybeauty.com"], "gucci": ["gucci.com"], "hugo boss": ["hugoboss.com"],
  "jean paul gaultier": ["jeanpaulgaultier.com"], "jimmy choo": ["jimmychoo.com"],
  "juicy couture": ["juicycouture.com"], "lattafa": ["lattafa.com"],
  "maison margiela": ["maisonmargiela-fragrances.us"], "mont blanc": ["montblanc.com"],
  "paco rabanne": ["rabanne.com"], "prada": ["prada.com", "prada-beauty.com"],
  "ralph lauren": ["ralphlaurenfragrances.com"], "rasasi": ["rasasistore.com"],
  "salvatore ferragamo": ["ferragamo.com"], "swiss arabian": ["swissarabian.com"],
};
export function approvedRetailSource(retailer: string, url: string, brand: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    const domains = retailer === "Official brand website" ? BRANDS[brand.toLowerCase()] ?? [] : RETAILERS[retailer] ?? [];
    return domains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch { return false; }
}
export function retailReferenceError(value: unknown, brand: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "Invalid Retail Reference.";
  const r = value as RetailReference;
  if (!["verified", "not_verified"].includes(r.status) || r.currency !== "USD" || typeof r.manuallyEdited !== "boolean") return "Invalid retail status/currency.";
  if (typeof r.checkedAt !== "string" || !Number.isFinite(Date.parse(r.checkedAt)) || Date.parse(r.checkedAt) > Date.now() + 86_400_000) return "Invalid checked date.";
  if (typeof r.identityKey !== "string" || typeof r.concentration !== "string" || typeof r.verificationNotes !== "string" || r.verificationNotes.length > 1000) return "Missing retail identity or verification notes.";
  if (r.status === "not_verified") return r.priceCents === null && r.referenceSize === null && r.retailer === null && r.sourceUrl === null ? null : "Unverified references must not carry a price.";
  if (!r.concentration.trim()) return "A verified reference needs an exact concentration.";
  if (!Number.isSafeInteger(r.priceCents) || (r.priceCents ?? 0) <= 0 || typeof r.referenceSize !== "string" || !r.referenceSize.trim()) return "A verified reference needs a positive price and labeled size.";
  if (typeof r.retailer !== "string" || typeof r.sourceUrl !== "string" || !approvedRetailSource(r.retailer, r.sourceUrl, brand)) return "Use an approved full-price retailer or this brand's official website.";
  return null;
}
export function isVerifiedRetail(p: RetailIdentity & { retailReference?: RetailReference | null }, now = Date.now()): boolean {
  const r = p.retailReference;
  return !!r && r.status === "verified" && !retailReferenceError(r, p.brand) && r.identityKey === retailIdentity(p)
    && r.concentration === p.concentration && now - Date.parse(r.checkedAt) <= 30 * 86_400_000;
}
