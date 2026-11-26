import type { Product } from "./types";

export interface RetailReference {
  // not_verified is retained for legacy records; new coverage uses estimates.
  status: "verified" | "estimated" | "manual" | "not_verified";
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
  "bond no. 9": ["bondno9.com"], "christian louboutin": ["christianlouboutin.com"],
  "azzaro": ["azzaro.com", "azzaroparfums.com"], "calvin klein": ["calvinklein.com", "calvinklein.us"],
  "carrera jeans": ["carrerajeans.com"], "creed": ["creedfragrance.com"],
  "davidoff": ["zino-davidoff.com"], "issey miyake": ["isseymiyakeparfums.com"],
  "marc jacobs": ["marcjacobsfragrances.com"], "mcm": ["mcmworldwide.com"],
  "moschino": ["moschino.com"], "nautica": ["nautica.com"], "xerjoff": ["xerjoff.com"],
  "tory burch": ["toryburch.com"], "valentino": ["valentino-beauty.us", "valentino-beauty.com"],
  "abercrombie & fitch": ["abercrombie.com"], "al haramain": ["alharamainperfumes.com"],
  "initio parfums prives": ["initioparfums.com"], "maison francis kurkdjian": ["franciskurkdjian.com"],
  "parfums de marly": ["parfums-de-marly.com"], "tom ford": ["tomfordbeauty.com", "tomford.com"],
  "clive christian": ["clivechristian.com"], "armaf": ["armafperfume.com"], "versace": ["versace.com"],
  "giorgio armani": ["armanibeauty-usa.com", "armani.com"], "emporio armani": ["armanibeauty-usa.com", "armani.com"],
  "tommy hilfiger": ["tommy.com"], "ariana grande": ["arianagrandefragrances.com"],
  "michael kors": ["michaelkors.com"], "yves saint laurent": ["yslbeautyus.com", "yslbeauty.com"],
  "lacoste": ["lacoste.com"], "french avenue": ["fragranceworld.ae"],
  "christian dior": ["dior.com"], "dior": ["dior.com"], "chanel": ["chanel.com"],
  "mugler": ["mugler.com", "muglerusa.com"], "viktor & rolf": ["viktor-rolf.com", "viktorandrolf.com"],
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
  if (!["verified", "estimated", "manual", "not_verified"].includes(r.status) || r.currency !== "USD" || typeof r.manuallyEdited !== "boolean") return "Invalid retail status/currency.";
  if (typeof r.checkedAt !== "string" || !Number.isFinite(Date.parse(r.checkedAt)) || Date.parse(r.checkedAt) > Date.now() + 86_400_000) return "Invalid checked date.";
  if (typeof r.identityKey !== "string" || typeof r.concentration !== "string" || typeof r.verificationNotes !== "string" || r.verificationNotes.length > 1000) return "Missing retail identity or verification notes.";
  if (r.status === "not_verified") return r.priceCents === null && r.referenceSize === null && r.retailer === null && r.sourceUrl === null ? null : "Unverified references must not carry a price.";
  if (r.status === "verified" && !r.concentration.trim()) return "A verified reference needs an exact concentration.";
  if (!Number.isSafeInteger(r.priceCents) || (r.priceCents ?? 0) <= 0 || typeof r.referenceSize !== "string" || !r.referenceSize.trim()) return "A verified reference needs a positive price and labeled size.";
  if (r.status === "estimated" && !r.verificationNotes.trim()) return "An estimate needs its basis and assumptions.";
  if (r.status === "verified" || r.retailer !== null || r.sourceUrl !== null) {
    if (typeof r.retailer !== "string" || typeof r.sourceUrl !== "string" || !approvedRetailSource(r.retailer, r.sourceUrl, brand)) return "Use an approved full-price retailer or this brand's official website, or leave both source fields empty for an estimate/manual price.";
  }
  return null;
}

/** Immediate local display; never substitutes legacy MSRP or sales prices.
 * A stale verified observation can still be a useful approximation, labelled ~.
 * Identity changes NEVER reuse the old price. The legacy manuallyEdited flag
 * protects operator edits but does not silently rewrite their stored status. */
export function retailPriceView(p: RetailIdentity & { retailReference?: RetailReference | null }, now = Date.now()) {
  const r = p.retailReference;
  if (!r || r.status === "not_verified" || retailReferenceError(r, p.brand) || r.identityKey !== retailIdentity(p) || r.concentration !== p.concentration) return null;
  const status = r.status === "verified" ? isVerifiedRetail(p, now) ? "verified" : "estimated" : r.status;
  return { reference: r, status } as { reference: RetailReference; status: "verified" | "estimated" | "manual" };
}
export function isVerifiedRetail(p: RetailIdentity & { retailReference?: RetailReference | null }, now = Date.now()): boolean {
  const r = p.retailReference;
  return !!r && r.status === "verified" && !retailReferenceError(r, p.brand) && r.identityKey === retailIdentity(p)
    && r.concentration === p.concentration && now - Date.parse(r.checkedAt) <= 30 * 86_400_000;
}
