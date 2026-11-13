import type { LiveNotes, Product } from "./types";
import { buildLiveNotes, fragranceKey, lookupSeed, MAX_KEY_NOTES } from "./live-notes";

// Pure planner used by scripts/populate-live-notes.ts. Decides what LIVE Notes
// each product should get; never touches anything but `liveNotes`.

export type SeedRow = [key: string, keyNotes: string, vibe: string, bestFor: string, check?: true];
export type SeedValue = { keyNotes: string; vibe: string; bestFor: string; check: boolean };

/** Seed rows → lookup table keyed by fragranceKey (+ "#m"/"#w" when the row key carries one). */
export function buildSeedTable(rows: SeedRow[]): Map<string, SeedValue> {
  const table = new Map<string, SeedValue>();
  for (const [rawKey, keyNotes, vibe, bestFor, check] of rows) {
    const [base, gender] = rawKey.split("#");
    const [brand, ...rest] = base.split("|");
    const key = fragranceKey({ brand, name: rest.join("|") }) + (gender ? `#${gender}` : "");
    if (table.has(key)) throw new Error(`Duplicate seed key: ${rawKey}`);
    table.set(key, { keyNotes, vibe, bestFor, check: !!check });
  }
  return table;
}

export type PlanAction = "fill" | "keep-manual" | "keep-existing" | "no-seed";
export interface PlanItem {
  id: string;
  label: string;
  action: PlanAction;
  next?: LiveNotes;
}

/** Plan LIVE Notes for in-stock products. Never overwrites notes a person typed
 *  (source "manual") and, unless `refresh`, never touches a product that already has notes. */
export function planLiveNotes(
  products: Product[],
  table: ReadonlyMap<string, SeedValue>,
  opts: { refresh?: boolean; includeOutOfStock?: boolean; now?: () => Date } = {}
): { items: PlanItem[]; usedKeys: Set<string> } {
  const items: PlanItem[] = [];
  const usedKeys = new Set<string>();
  for (const p of products) {
    if (p.inventory <= 0 && !opts.includeOutOfStock) continue;
    const label = `${p.brand} ${p.name} ${p.size}`.trim();
    if (p.liveNotes?.source === "manual") { items.push({ id: p.id, label, action: "keep-manual" }); continue; }
    if (p.liveNotes && !opts.refresh) { items.push({ id: p.id, label, action: "keep-existing" }); continue; }
    const seed = lookupSeed(table, p);
    if (!seed) { items.push({ id: p.id, label, action: "no-seed" }); continue; }
    usedKeys.add(fragranceKey(p));
    // Reuse the sourced selling reference's key notes when we have them; the seed supplies vibe + best-for.
    const researched = (p.sellingKeyNotes ?? []).filter(Boolean);
    const reuse = researched.length >= 3;
    const next = buildLiveNotes(
      { keyNotes: reuse ? researched.slice(0, MAX_KEY_NOTES) : seed.keyNotes, vibe: seed.vibe, bestFor: seed.bestFor },
      { source: reuse ? "researched" : "ai_draft", check: reuse ? false : seed.check, now: opts.now }
    );
    items.push({ id: p.id, label, action: "fill", next });
  }
  return { items, usedKeys };
}

/** Apply a plan to a product list (pure). Returns new list; every product's other fields are identical. */
export function applyPlan(products: Product[], items: PlanItem[]): Product[] {
  const byId = new Map(items.filter((i) => i.action === "fill" && i.next).map((i) => [i.id, i.next!]));
  return products.map((p) => (byId.has(p.id) ? { ...p, liveNotes: byId.get(p.id) } : p));
}
