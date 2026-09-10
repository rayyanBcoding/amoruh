import { redis } from "./kv";

// ---------------------------------------------------------------------
// The ONE place that enforces "at most one active Real Live OR Test
// Live, never both." Imported by BOTH live-db.ts and test-live-db.ts —
// never the other way around — so there is no import cycle and neither
// module needs to know anything about the other's internals beyond
// these two pointer keys.
//
// A plain "GET the other pointer, then SETNX my own" would race: two
// simultaneous START LIVE / START TEST LIVE requests could each see the
// other pointer unset and both succeed. claimActiveSession() checks BOTH
// pointers and writes the session/state/index for the requested mode in
// one atomic Lua script — a claim is either fully applied (pointer +
// session + state + index, all four) or nothing is written at all, so
// there's never an orphan session record left behind by a claim that
// ultimately loses the race.
// ---------------------------------------------------------------------

export const REAL_ACTIVE_KEY = "amoruh:live:active_session_id";
export const TEST_ACTIVE_KEY = "amoruh:testlive:active_session_id";

export type SessionMode = "real" | "test";

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; existingSessionId: string }
  | { claimed: false; blockedByOtherMode: true };

// KEYS[1] real active pointer
// KEYS[2] test active pointer
// KEYS[3] session key for the REQUESTED mode
// KEYS[4] sessions_index zset for the REQUESTED mode
// KEYS[5] session_state key for the REQUESTED mode
// ARGV[1] mode ("real" | "test")
// ARGV[2] sessionId (bare string — see the JSON-auto-parse note below)
// ARGV[3] session (JSON)
// ARGV[4] score (timestamp ms, string)
// ARGV[5] session_state (JSON)
//
// Returns a bare string always — never a JSON-shaped value. Upstash's
// client auto-deserializes anything a script returns (or that gets
// stored via a plain SET) that happens to parse as JSON, which silently
// turns an intended string into an already-parsed object on the caller
// side (this bit Go Live's Record Sale/End Live once already — see git
// history). Every return path here is either a bare session id or one
// of the two literal status words below, by design.
const CLAIM_SCRIPT = `
local realActive = redis.call('GET', KEYS[1])
local testActive = redis.call('GET', KEYS[2])
if ARGV[1] == 'real' then
  if realActive then return realActive end
  if testActive then return 'BLOCKED_BY_TEST' end
  redis.call('SET', KEYS[1], ARGV[2])
else
  if testActive then return testActive end
  if realActive then return 'BLOCKED_BY_REAL' end
  redis.call('SET', KEYS[2], ARGV[2])
end
redis.call('SET', KEYS[3], ARGV[3])
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[2])
redis.call('SET', KEYS[5], ARGV[5])
return ARGV[2]
`;

export interface ClaimActiveSessionInput {
  mode: SessionMode;
  sessionKey: string;
  sessionsIndexKey: string;
  sessionStateKey: string;
  sessionId: string;
  sessionJSON: string;
  score: string;
  stateJSON: string;
}

export async function claimActiveSession(input: ClaimActiveSessionInput): Promise<ClaimResult> {
  const keys = [REAL_ACTIVE_KEY, TEST_ACTIVE_KEY, input.sessionKey, input.sessionsIndexKey, input.sessionStateKey];
  const args = [input.mode, input.sessionId, input.sessionJSON, input.score, input.stateJSON];

  const result = await redis.eval<(string | number)[], string>(CLAIM_SCRIPT, keys, args);
  if (result === "BLOCKED_BY_TEST" || result === "BLOCKED_BY_REAL") {
    return { claimed: false, blockedByOtherMode: true };
  }
  if (result === input.sessionId) {
    return { claimed: true };
  }
  return { claimed: false, existingSessionId: result };
}
