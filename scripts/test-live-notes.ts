// LIVE Notes: helpers, populate planner, validation, and the PUT { liveNotes } save path.
// HERMETIC: in-memory fake Redis via globalThis.__amoruhRedis; no production data.
//   npx tsx scripts/test-live-notes.ts
export {};
let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.log(`FAIL: ${label}\n   expected ${JSON.stringify(expected)}\n   got      ${JSON.stringify(actual)}`);
  }
}

class Fake {
  store = new Map<string, string>();
  async get(k: string) { const v = this.store.get(k); return v === undefined ? null : JSON.parse(v); }
  async set(k: string, v: unknown) { this.store.set(k, JSON.stringify(v)); return "OK"; }
  async del(k: string) { this.store.delete(k); return 1; }
  async incr(k: string) { const n = Number(this.store.get(k) ?? 0) + 1; this.store.set(k, String(n)); return n; }
}
const fake = new Fake();
(globalThis as unknown as { __amoruhRedis: unknown }).__amoruhRedis = new Proxy(fake, {
  get(t, p, r) {
    if (p === "then") return undefined;
    if (p in t) return Reflect.get(t, p, r);
    return () => { throw new Error(`unexpected redis.${String(p)}()`); };
  },
});

const prod = (id: string, brand: string, name: string, over: Record<string, unknown> = {}) => ({
  id, sku: id, barcode: id, brand, name, size: "100ml", concentration: "", image: "", color: "#000", cost: 10, retailPrice: 0, marketPrice: 0, lootPrice: 0, minPrice: 0,
  topNotes: [], middleNotes: [], baseNotes: [], projection: "", longevity: "", description: "", condition: "New", shelf: "", inventory: 3, authentic: true, tiktokListing: "", status: "draft", ...over,
});

async function main() {
  const L = await import("../src/lib/live-notes");
  const { buildSeedTable, planLiveNotes, applyPlan } = await import("../src/lib/live-notes-plan");
  const { SEED } = await import("./data/live-notes-seed");
  const { KEYS } = await import("../src/lib/kv");
  const { PUT } = await import("../src/app/api/products/[id]/route");
  type P = Parameters<typeof L.getLiveNotesView>[0] & { id: string; inventory: number; brand: string; name: string; size: string; description: string; liveNotes?: import("../src/lib/types").LiveNotes; sellingKeyNotes?: string[] };

  // ---------- parsing / building ----------
  check("parseKeyNotes splits, trims, dedupes, caps at 5", L.parseKeyNotes("Vanilla, tonka ·Amber\nvanilla; Musk, Rose, Oud"), ["Vanilla", "tonka", "Amber", "Musk", "Rose"]);
  const built = L.buildLiveNotes({ keyNotes: "A, B", vibe: "  sweet   warm ", bestFor: "Fall" }, { now: () => new Date("2026-11-13T00:00:00Z") });
  check("buildLiveNotes normalizes + defaults to manual", built, { keyNotes: ["A", "B"], vibe: "sweet warm", bestFor: "Fall", source: "manual", updatedAt: "2026-11-13T00:00:00.000Z" });
  check("check flag only when requested", [L.buildLiveNotes({ keyNotes: "A", vibe: "", bestFor: "" }).check, L.buildLiveNotes({ keyNotes: "A", vibe: "", bestFor: "" }, { check: true }).check], [undefined, true]);

  // ---------- display fallback order ----------
  const base = { topNotes: [], middleNotes: [], baseNotes: [] };
  check("nothing → null", L.getLiveNotesView({ ...base }), null);
  check("plain fragrance notes → fallback", L.getLiveNotesView({ ...base, fragranceNotes: ["Rose", "Musk"] })?.source, "fallback");
  check("researched selling reference beats plain notes", L.getLiveNotesView({ ...base, fragranceNotes: ["x"], sellingKeyNotes: ["A", "B", "C"], sellingScentProfile: ["Fresh", "Clean"] })?.vibe, "Fresh, Clean");
  check("saved LIVE notes beat everything", L.getLiveNotesView({ ...base, sellingKeyNotes: ["A"], liveNotes: built })?.keyNotes, ["A", "B"]);
  check("one-liner", L.liveNotesOneLiner(L.getLiveNotesView({ ...base, liveNotes: built })), "A · B — sweet warm");
  check("one-liner empty when no notes", L.liveNotesOneLiner(null), "");

  // ---------- validation ----------
  check("valid shape accepted", L.liveNotesError(built), null);
  check("undefined/null accepted", [L.liveNotesError(undefined), L.liveNotesError(null)], [null, null]);
  check("non-object rejected", typeof L.liveNotesError("x"), "string");
  check("too many notes rejected", typeof L.liveNotesError({ ...built, keyNotes: Array(9).fill("a") }), "string");
  check("bad source rejected", typeof L.liveNotesError({ ...built, source: "hacker" }), "string");
  check("overlong vibe rejected", typeof L.liveNotesError({ ...built, vibe: "x".repeat(200) }), "string");

  // ---------- matching variants ----------
  const k = (b: string, n: string) => L.fragranceKey({ brand: b, name: n });
  check("tester / gender tags stripped", k("Creed", "Love In Black (W) Tester"), k("Creed", "Love In Black"));
  check("set suffix stripped", k("Paco Rabanne", "Invictus 3PC Set"), k("Paco Rabanne", "Invictus"));
  check("set contents stripped", k("Mont Blanc", "Legend Red Set (EDP 100ml + EDP 7.5ml + SG 100ml)"), k("Mont Blanc", "Legend Red"));
  check("fabric variant stays separate from men's London", k("Burberry", "London (Fabric) (Tester) EDP") !== k("Burberry", "London"), true);
  check("gender from tag", [L.genderOf({ name: "X", description: "FOO (W)(T) EDP" }), L.genderOf({ name: "X", description: "TSTM-FOO 3.4" }), L.genderOf({ name: "X", description: "" })], ["w", "m", null]);

  // ---------- seed file integrity ----------
  const table = buildSeedTable(SEED);
  check("seed builds with no duplicate keys", table.size, SEED.length);
  let bad = 0;
  for (const [key, v] of table) {
    const n = L.parseKeyNotes(v.keyNotes);
    if (n.length < 3 || n.length > 5 || !v.vibe || !v.bestFor || n.length !== v.keyNotes.split(",").length) { bad++; console.log("  bad seed:", key, v.keyNotes); }
  }
  check("every seed row has 3–5 distinct notes + vibe + best-for", bad, 0);

  // ---------- planner ----------
  const products = [
    prod("a", "Paco Rabanne", "1 Million (tester)"),
    prod("b", "Paco Rabanne", "1 Million 3PC Set", { inventory: 2 }),
    prod("c", "Azzaro", "Chrome Legend", { sellingKeyNotes: ["Green Apple", "Bitter Orange", "Tea", "Vetiver", "Amber & Musk"], sellingScentProfile: ["Fresh"] }),
    prod("d", "Guess", "Seductive", { description: "GUESS SEDUCTIVE(W)EDT SP 2.5oz" }),
    prod("e", "Guess", "Seductive", { description: "GUESS SEDUCTIVE(M)EDT SP 3.4oz" }),
    prod("f", "Nobody", "Unknown Scent"),
    prod("g", "Creed", "Aventus", { inventory: 0 }),
    prod("h", "Creed", "Himalaya", { liveNotes: L.buildLiveNotes({ keyNotes: "Mine, Typed, By hand", vibe: "my vibe", bestFor: "my best" }) }),
    prod("i", "Creed", "Love In Black", { liveNotes: { ...L.buildLiveNotes({ keyNotes: "Old, Draft, Notes", vibe: "v", bestFor: "b" }, { source: "ai_draft" }) } }),
  ] as unknown as import("../src/lib/types").Product[];
  const plan = planLiveNotes(products, table, { now: () => new Date("2026-11-13T00:00:00Z") });
  const act = (id: string) => plan.items.find((i) => i.id === id)?.action;
  check("tester + set variants of one scent are both filled", [act("a"), act("b")], ["fill", "fill"]);
  check("no seed → left alone, reported", act("f"), "no-seed");
  check("out-of-stock skipped by default", act("g"), undefined);
  check("manual notes are never overwritten", act("h"), "keep-manual");
  check("existing draft notes kept without --refresh", act("i"), "keep-existing");
  const refreshed = planLiveNotes(products, table, { refresh: true });
  check("--refresh redoes drafts but still protects manual", [refreshed.items.find((i) => i.id === "i")?.action, refreshed.items.find((i) => i.id === "h")?.action], ["fill", "keep-manual"]);
  const c = plan.items.find((i) => i.id === "c")!.next!;
  check("sourced notes are reused (not replaced)", [c.keyNotes, c.source, c.check], [["Green Apple", "Bitter Orange", "Tea", "Vetiver", "Amber & Musk"], "researched", undefined]);
  check("gendered Guess Seductive picks the right row", [plan.items.find((i) => i.id === "d")!.next!.keyNotes[0], plan.items.find((i) => i.id === "e")!.next!.keyNotes[0]], ["Mandarin", "Citrus"]);
  const applied = applyPlan(products, plan.items);
  const strip = (p: unknown) => { const { liveNotes: _l, ...r } = p as Record<string, unknown>; void _l; return JSON.stringify(r); };
  check("applying a plan changes only liveNotes on every product", products.every((p, i) => strip(p) === strip(applied[i])), true);
  check("inventory + price untouched", applied.map((p) => [p.inventory, p.cost]), products.map((p) => [p.inventory, p.cost]));

  // ---------- save path: PUT /api/products/[id] with { liveNotes } only ----------
  fake.store.clear();
  await fake.set(KEYS.products, [prod("p1", "Brand", "One", { inventory: 7, cost: 12.5, lootPrice: 30 }), prod("p2", "Brand", "Two")]);
  const put = async (body: unknown) => {
    const res = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "p1" }) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  let r = await put({ liveNotes: L.buildLiveNotes({ keyNotes: "Rose, Musk, Amber", vibe: "Soft", bestFor: "Spring" }) });
  const saved = ((await fake.get(KEYS.products)) as P[])[0] as unknown as P & { cost: number; lootPrice: number };
  check("editor save stores liveNotes", [r.status, saved.liveNotes?.keyNotes, saved.liveNotes?.source], [200, ["Rose", "Musk", "Amber"], "manual"]);
  check("…and leaves inventory / cost / price alone", [saved.inventory, saved.cost, saved.lootPrice], [7, 12.5, 30]);
  check("…and the other product is untouched", (((await fake.get(KEYS.products)) as P[])[1] as P).liveNotes, undefined);
  r = await put({ liveNotes: { keyNotes: "nope", vibe: "", bestFor: "", source: "manual" } });
  check("malformed liveNotes (keyNotes not a list) → 400, nothing saved", [r.status, (((await fake.get(KEYS.products)) as P[])[0] as P).liveNotes?.keyNotes], [400, ["Rose", "Musk", "Amber"]]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(1); });
