import { EventEmitter } from "events";

// Process-wide pub/sub used to fan out "the live state changed" pings to
// every open SSE connection (Operator Dashboard tabs, TV Display tabs).
//
// V1 note: this is in-memory and single-process, which is fine for one
// `next dev` / `next start` instance running the show. Scaling to multiple
// server instances (multiple TVs across venues, etc.) means swapping this
// for a real pub/sub (Redis, etc.) — every publisher/subscriber call below
// stays the same shape.

declare global {
  var __lootDepotEmitter: EventEmitter | undefined;
}

export const LIVE_STATE_CHANGED = "live-state-changed";

export const liveEmitter: EventEmitter =
  globalThis.__lootDepotEmitter ??
  (() => {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(200);
    return emitter;
  })();

globalThis.__lootDepotEmitter = liveEmitter;

export function broadcastStateChanged(reason: string) {
  liveEmitter.emit(LIVE_STATE_CHANGED, { reason, at: new Date().toISOString() });
}
