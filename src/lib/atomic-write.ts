import { redis } from "./kv";

// ---------------------------------------------------------------------
// Generic atomic write primitive, extracted from Phase 2's
// intake-receiving.ts so it can be reused outside that one file (pure
// move — same script, same signature, no behavior change to any
// existing receiving call site).
//
// One Lua script that checks-and-marks an idempotency key AND applies
// every data write as a single atomic unit on the Redis server. See the
// Phase 2 plan ("Revised: Lua idempotency flow") for why this replaced
// both redis.multi() (isolation, not rollback) and an app-level-only
// idempotency pre-check (has a TOCTOU race across concurrent requests).
//
// This is intentionally a flat, unconditional SET loop — no branching,
// no per-key logic — because that's what makes the script boring enough
// to trust. Anything that needs a compare-and-swap / conditional write
// (see sales-analytics.ts's version-checked Mark Sold script) gets its
// own small, purpose-built script instead of bolting conditionals onto
// this one.
// ---------------------------------------------------------------------

export interface Write {
  key: string;
  value: unknown;
}

const ATOMIC_WRITE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
for i = 2, #KEYS do
  redis.call('SET', KEYS[i], ARGV[i])
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export async function atomicWrite(idempotencyKey: string, resultId: string, writes: Write[]): Promise<string> {
  const keys = [idempotencyKeyOf(idempotencyKey), ...writes.map((w) => w.key)];
  const args = [resultId, ...writes.map((w) => JSON.stringify(w.value))];
  const result = await redis.eval<(string | number)[], string>(ATOMIC_WRITE_SCRIPT, keys, args);
  return result;
}

/** Fast-path optimization only — NOT the source of duplicate protection.
 *  The Lua script's own GET-then-SET is the real authority (see above). */
export async function checkIdempotencyFast(idempotencyKey: string): Promise<string | null> {
  return (await redis.get<string>(idempotencyKeyOf(idempotencyKey))) ?? null;
}

/** Exported so any dedicated (non-generic) atomic script — e.g.
 *  sales-analytics.ts's version-checked Mark Sold script — can put its
 *  idempotency guard in the exact same keyspace this module's fast-path
 *  check reads from. */
export function idempotencyKeyOf(idempotencyKey: string): string {
  return `amoruh:intake:idempotency:${idempotencyKey}`;
}
