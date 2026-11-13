// Populate LIVE Notes (Key notes / Vibe / Best for) for in-stock products.
//
//   npx tsx scripts/populate-live-notes.ts                 # DRY RUN: prints what would change, writes nothing
//   npx tsx scripts/populate-live-notes.ts --apply --backup <file.json>
//
// SAFETY
//  - Writes ONLY the `liveNotes` field. Verified before and after the write:
//    every other field of every product is identical, and the set of product
//    ids / inventory / prices are unchanged. If anything else differs it aborts.
//  - Never overwrites notes a person typed (source "manual"). Re-running is a
//    no-op unless --refresh is passed (which still skips manual notes).
//  - Reads fresh products immediately before the single write, so a concurrent
//    edit/sale a moment earlier is preserved.
//  - --apply requires --backup: the full pre-change products array is saved there first.
//  - Never imports intake/sales/pricing/TikTok code.
import { existsSync, writeFileSync } from "node:fs";
for (const f of [".env.development.local", ".env.local"]) if (existsSync(f)) process.loadEnvFile(f);

async function main() {
  const { getProducts, saveProducts } = await import("../src/lib/db");
  const { SEED } = await import("./data/live-notes-seed");
  const { buildSeedTable, planLiveNotes, applyPlan } = await import("../src/lib/live-notes-plan");
  const { fragranceKey } = await import("../src/lib/live-notes");

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const refresh = args.includes("--refresh");
  const backupIdx = args.indexOf("--backup");
  const backup = backupIdx >= 0 ? args[backupIdx + 1] : undefined;
  if (apply && !backup) throw new Error("--apply requires --backup <file.json>");

  const table = buildSeedTable(SEED);
  const before = await getProducts();
  const { items } = planLiveNotes(before, table, { refresh });
  const by = (a: string) => items.filter((i) => i.action === a);
  console.log(`products total ${before.length}; in stock considered ${items.length}`);
  console.log(`  fill: ${by("fill").length}  keep-manual: ${by("keep-manual").length}  keep-existing: ${by("keep-existing").length}  no-seed: ${by("no-seed").length}`);
  const draftCheck = by("fill").filter((i) => i.next?.check).length;
  console.log(`  of the fills: ${by("fill").filter((i) => i.next?.source === "researched").length} reuse sourced notes, ${draftCheck} flagged "check before quoting"`);
  for (const i of by("no-seed")) console.log(`  NO SEED  ${i.label}`);
  const known = new Set(before.map((p) => fragranceKey(p)));
  const unused = [...table.keys()].filter((k) => !k.includes("#") && !known.has(k));
  if (unused.length) console.log(`seed rows with no matching product (fine — just not in stock): ${unused.length}`);

  if (!apply) { console.log("\nDRY RUN — nothing written. Re-run with --apply --backup <file>."); return; }

  // Fresh read right before writing, re-plan on it, verify, write once.
  const fresh = await getProducts();
  writeFileSync(backup!, JSON.stringify(fresh, null, 1));
  const plan = planLiveNotes(fresh, table, { refresh });
  const next = applyPlan(fresh, plan.items);

  const strip = (p: Record<string, unknown>) => { const { liveNotes: _l, ...rest } = p; void _l; return JSON.stringify(rest); };
  if (next.length !== fresh.length) throw new Error("product count changed — aborting");
  for (let i = 0; i < fresh.length; i++) {
    if (fresh[i].id !== next[i].id || strip(fresh[i] as never) !== strip(next[i] as never)) throw new Error(`non-liveNotes field would change on ${fresh[i].id} — aborting`);
  }
  await saveProducts(next);

  const after = await getProducts();
  const filled = after.filter((p) => p.liveNotes).length;
  for (let i = 0; i < fresh.length; i++) {
    const a = after.find((p) => p.id === fresh[i].id);
    if (!a || strip(a as never) !== strip(fresh[i] as never)) throw new Error(`post-write check failed for ${fresh[i].id} (concurrent edit?) — inspect, backup is at ${backup}`);
  }
  console.log(`\nAPPLIED. ${plan.items.filter((i) => i.action === "fill").length} products filled; ${filled} products now have LIVE Notes. Backup: ${backup}`);
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
