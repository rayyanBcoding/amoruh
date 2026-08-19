import { KEYS, redis } from "./kv";

// The app runs as Vercel serverless functions, so there's no shared
// in-process event bus a POST handler and an open SSE connection could
// both subscribe to — they may run on entirely different instances.
// Redis is shared across every instance, so `db.ts` already bumps a
// version counter on every write. This function is kept as an explicit,
// same-named call site (so route handlers don't need to change) that
// nudges that same counter — see `src/app/api/events/route.ts`, which
// polls it to know when to push a fresh snapshot.
export async function broadcastStateChanged(reason: string) {
  void reason; // kept for call-site readability (e.g. "scan", "mark-sold")
  await redis.incr(KEYS.version);
}
