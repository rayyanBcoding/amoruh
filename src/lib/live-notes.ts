import type { LiveNotes, Product } from "./types";
import { getFragranceNotes } from "./fragrance-notes";

// LIVE Notes: the short "Key notes / Vibe / Best for" block shown on Go Live.
// Pure helpers only — no Redis, no side effects.

export const MAX_KEY_NOTES = 5;
const MAX_TEXT = 140;

/** What the Go Live card renders. `complete` is false when the product has
 *  only a fallback (older researched/manual notes) or nothing at all. */
export interface LiveNotesView {
  keyNotes: string[];
  vibe: string;
  bestFor: string;
  source: LiveNotes["source"] | "fallback";
  check: boolean;
}

/** "Vanilla, Tonka · Amber\nMusk" → ["Vanilla","Tonka","Amber","Musk"] (deduped, max 5). */
export function parseKeyNotes(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,·•\n;|]/)) {
    const n = raw.trim().replace(/\s+/g, " ");
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
    if (out.length >= MAX_KEY_NOTES) break;
  }
  return out;
}

/** Trim + clamp operator input into a storable LiveNotes. */
export function buildLiveNotes(
  input: { keyNotes: string[] | string; vibe: string; bestFor: string },
  opts: { source?: LiveNotes["source"]; check?: boolean; now?: () => Date } = {}
): LiveNotes {
  const keyNotes = (Array.isArray(input.keyNotes) ? input.keyNotes.join(",") : input.keyNotes) as string;
  const out: LiveNotes = {
    keyNotes: parseKeyNotes(keyNotes),
    vibe: String(input.vibe ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_TEXT),
    bestFor: String(input.bestFor ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_TEXT),
    source: opts.source ?? "manual",
    updatedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
  if (opts.check) out.check = true;
  return out;
}

export function hasLiveNotes(p: Pick<Product, "liveNotes">): boolean {
  const n = p.liveNotes;
  return !!n && (n.keyNotes.length > 0 || !!n.vibe || !!n.bestFor);
}

/** The block to show for a product, or null if there is nothing to show.
 *  Order: saved LIVE Notes → older researched selling reference → plain fragrance notes. */
export function getLiveNotesView(
  p: Pick<Product, "liveNotes" | "sellingKeyNotes" | "sellingScentProfile" | "fragranceNotes" | "topNotes" | "middleNotes" | "baseNotes">
): LiveNotesView | null {
  if (p.liveNotes && hasLiveNotes(p as Pick<Product, "liveNotes">)) {
    return { keyNotes: p.liveNotes.keyNotes, vibe: p.liveNotes.vibe, bestFor: p.liveNotes.bestFor, source: p.liveNotes.source, check: !!p.liveNotes.check };
  }
  if (p.sellingKeyNotes && p.sellingKeyNotes.length > 0) {
    return { keyNotes: p.sellingKeyNotes.slice(0, MAX_KEY_NOTES), vibe: (p.sellingScentProfile ?? []).join(", "), bestFor: "", source: "fallback", check: false };
  }
  const plain = getFragranceNotes({ fragranceNotes: p.fragranceNotes, topNotes: p.topNotes ?? [], middleNotes: p.middleNotes ?? [], baseNotes: p.baseNotes ?? [] });
  if (plain.length > 0) return { keyNotes: plain.slice(0, MAX_KEY_NOTES), vibe: "", bestFor: "", source: "fallback", check: false };
  return null;
}

/** One-line summary for search dropdowns: "Vanilla · Tonka · Amber — Sweet, warm". */
export function liveNotesOneLiner(view: LiveNotesView | null): string {
  if (!view) return "";
  const notes = view.keyNotes.slice(0, 4).join(" · ");
  return [notes, view.vibe].filter(Boolean).join(" — ");
}

/** Server-side shape check for PUT /api/products/[id]. Returns an error message or null. */
export function liveNotesError(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return "LIVE Notes must be an object.";
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.keyNotes) || o.keyNotes.length > 8 || o.keyNotes.some((n) => typeof n !== "string" || n.length > 60)) return "Key notes must be a short list of words.";
  if (typeof o.vibe !== "string" || o.vibe.length > MAX_TEXT) return "Vibe must be short text.";
  if (typeof o.bestFor !== "string" || o.bestFor.length > MAX_TEXT) return "Best for must be short text.";
  if (o.source !== "ai_draft" && o.source !== "researched" && o.source !== "manual") return "Unknown notes source.";
  return null;
}

// ---------- matching one fragrance across size / tester / set variants ----------

/** Same scent, different listing: strips (M)/(W)/(U), "Tester", set suffixes,
 *  set contents "(EDP 100ml + ...)", concentration words. */
export function fragranceKey(p: Pick<Product, "brand" | "name">): string {
  let n = `${p.brand}|${p.name}`.toLowerCase();
  n = n.replace(/\([^)]*(\+|\d\s*ml)[^)]*\)/g, " "); // set contents
  n = n.replace(/\((m|w|u|m\.|w\.|tester[^)]*|refillable|glass bottle|tube spray)\)/g, " ");
  n = n.replace(/\b(tester|w\/cap|tube spray|refillable|glass bottle)\b/g, " ");
  n = n.replace(/\b\d+\s*pc\s*set\b/g, " ");
  n = n.replace(/\bedp\b|\bedt\b/g, " ");
  n = n.replace(/\bset\b\s*$/, " ");
  return n.replace(/[^a-z0-9|%&]+/g, " ").replace(/\s*\|\s*/g, "|").replace(/\s+/g, " ").trim();
}

export type Gender = "m" | "w" | "u";

/** Men's / women's / unisex from the supplier-style tags in name or description. */
export function genderOf(p: Pick<Product, "name" | "description">): Gender | null {
  const text = `${p.name} ${p.description ?? ""}`;
  const tag = text.match(/\((m|w|u)\.?\)/i);
  if (tag) return tag[1].toLowerCase() as Gender;
  const pre = (p.description ?? "").match(/^(tstm|tstw|zzm|zzw|m|w)-/i);
  if (pre) return pre[1].toLowerCase().endsWith("w") ? "w" : "m";
  return null;
}

/** Look a product up in a seed table keyed by fragranceKey (gendered "#m"/"#w" key wins). */
export function lookupSeed<T>(table: ReadonlyMap<string, T>, p: Pick<Product, "brand" | "name" | "description">): T | undefined {
  const key = fragranceKey(p);
  const g = genderOf(p);
  return (g ? table.get(`${key}#${g}`) : undefined) ?? table.get(key);
}
