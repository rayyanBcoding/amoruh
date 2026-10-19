// In-memory Redis for HERMETIC tests of code that uses Lua scripts (EVAL).
//
// - Implements the subset of the @upstash/redis client the Go Live sales code
//   uses (get/set/del/mget/incr/zadd/zrange/zcard/zscore/zrem/rpush/lrange/
//   ltrim/eval) and mimics Upstash's JSON auto-(de)serialization on reads.
// - EVAL runs the app's REAL Lua source through fengari (a pure-JS Lua VM).
//   redis.call(...) and cjson.decode(...) are provided here. Every script
//   executes synchronously with no awaits, so — like Redis itself — a script
//   is atomic with respect to every other caller.
// - Anything not implemented THROWS, so a surprise code path fails loudly.
//
// Inject with:  (globalThis as any).__amoruhRedis = new FakeRedis()
// before the first import of src/lib/kv.ts. No production credentials are
// ever read or used.
/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fengari = require("fengari");
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const NULL_SENTINEL = { cjsonNull: true };

type ZSet = Map<string, number>;

export class FakeRedis {
  strings = new Map<string, string>();
  zsets = new Map<string, ZSet>();
  lists = new Map<string, string[]>();
  /** every key written by a script or command, for "nothing else was touched" assertions */
  written = new Set<string>();
  evalCount = 0;

  // ---- raw string/zset/list commands (also used by Lua redis.call) ----
  private rawGet(key: string): string | null {
    return this.strings.has(key) ? (this.strings.get(key) as string) : null;
  }
  private rawSet(key: string, value: string) {
    this.strings.set(key, value);
    this.written.add(key);
  }
  private rawZadd(key: string, score: number, member: string) {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    z.set(member, score);
    this.zsets.set(key, z);
    this.written.add(key);
  }
  private sortedMembers(key: string): [string, number][] {
    const z = this.zsets.get(key);
    if (!z) return [];
    // score asc, then member lexicographic (Redis order)
    return [...z.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  private decode(v: string | null): any {
    if (v === null) return null;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  private encode(v: unknown): string {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  // ---- Upstash-style client API ----
  async get<T = any>(key: string): Promise<T | null> {
    return this.decode(this.rawGet(key));
  }
  async set(key: string, value: unknown) {
    this.rawSet(key, this.encode(value));
    return "OK";
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) {
      if (this.strings.delete(k) || this.zsets.delete(k) || this.lists.delete(k)) n++;
      this.written.add(k);
    }
    return n;
  }
  async mget<T = any>(...keys: string[]): Promise<(T | null)[]> {
    return keys.map((k) => this.decode(this.rawGet(k)));
  }
  async incr(key: string) {
    const n = Number(this.rawGet(key) ?? 0) + 1;
    this.rawSet(key, String(n));
    return n;
  }
  async zadd(key: string, entry: { score: number; member: string }) {
    this.rawZadd(key, entry.score, entry.member);
    return 1;
  }
  async zrem(key: string, ...members: string[]) {
    let n = 0;
    for (const m of members) if (this.zsets.get(key)?.delete(m)) n++;
    this.written.add(key);
    return n;
  }
  async zcard(key: string) {
    return this.zsets.get(key)?.size ?? 0;
  }
  async zscore(key: string, member: string) {
    const v = this.zsets.get(key)?.get(member);
    return v === undefined ? null : v;
  }
  async zrange(key: string, start: number, stop: number, opts?: { rev?: boolean; withScores?: boolean }) {
    let all = this.sortedMembers(key);
    if (opts?.rev) all = all.reverse();
    const end = stop < 0 ? all.length + stop : stop;
    const slice = all.slice(start < 0 ? Math.max(0, all.length + start) : start, end + 1);
    if (opts?.withScores) return slice.flatMap(([m, s]) => [m, s]);
    return slice.map(([m]) => m);
  }
  async lrange(key: string, start: number, stop: number) {
    const l = this.lists.get(key) ?? [];
    const end = stop < 0 ? l.length + stop : stop;
    return l.slice(start < 0 ? Math.max(0, l.length + start) : start, end + 1).map((v) => this.decode(v));
  }
  async llen(key: string) {
    return this.lists.get(key)?.length ?? 0;
  }
  async rpush(key: string, ...values: unknown[]) {
    const l = this.lists.get(key) ?? [];
    for (const v of values) l.push(this.encode(v));
    this.lists.set(key, l);
    this.written.add(key);
    return l.length;
  }

  // ---- Lua ----
  async eval<TArgs extends unknown[], TResult>(script: string, keys: string[], args: TArgs): Promise<TResult> {
    this.evalCount++;
    return this.runLua(script, keys, args.map((a) => String(a))) as TResult;
  }

  private redisCall(cmd: string, a: string[]): string | number | false {
    switch (cmd.toUpperCase()) {
      case "GET": {
        const v = this.rawGet(a[0]);
        return v === null ? false : v;
      }
      case "SET":
        this.rawSet(a[0], a[1]); // EX/NX options are not needed by the app's scripts
        return "OK";
      case "DEL": {
        this.strings.delete(a[0]);
        this.written.add(a[0]);
        return 1;
      }
      case "INCR": {
        const n = Number(this.rawGet(a[0]) ?? 0) + 1;
        this.rawSet(a[0], String(n));
        return n;
      }
      case "ZADD":
        this.rawZadd(a[0], Number(a[1]), a[2]);
        return 1;
      case "ZREM": {
        const had = this.zsets.get(a[0])?.delete(a[1]) ? 1 : 0;
        this.written.add(a[0]);
        return had;
      }
      case "RPUSH": {
        const l = this.lists.get(a[0]) ?? [];
        for (const v of a.slice(1)) l.push(v);
        this.lists.set(a[0], l);
        this.written.add(a[0]);
        return l.length;
      }
      case "LTRIM": {
        const l = this.lists.get(a[0]) ?? [];
        const s = Number(a[1]);
        const e = Number(a[2]);
        const from = s < 0 ? Math.max(0, l.length + s) : s;
        const to = e < 0 ? l.length + e : e;
        this.lists.set(a[0], l.slice(from, to + 1));
        this.written.add(a[0]);
        return "OK";
      }
      default:
        throw new Error(`FakeRedis: unimplemented Lua redis.call('${cmd}')`);
    }
  }

  private runLua(script: string, keys: string[], argv: string[]): unknown {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const pushStr = (s: string) => lua.lua_pushstring(L, to_luastring(s));
    const tabFrom = (arr: string[], name: string) => {
      lua.lua_createtable(L, arr.length, 0);
      arr.forEach((s, i) => {
        pushStr(s);
        lua.lua_rawseti(L, -2, i + 1);
      });
      lua.lua_setglobal(L, to_luastring(name));
    };
    tabFrom(keys, "KEYS");
    tabFrom(argv, "ARGV");

    const pushJson = (v: any) => {
      if (v === null) lua.lua_pushlightuserdata(L, NULL_SENTINEL);
      else if (typeof v === "boolean") lua.lua_pushboolean(L, v);
      else if (typeof v === "number") {
        if (Number.isInteger(v)) lua.lua_pushinteger(L, v);
        else lua.lua_pushnumber(L, v);
      }
      else if (typeof v === "string") pushStr(v);
      else if (Array.isArray(v)) {
        lua.lua_createtable(L, v.length, 0);
        v.forEach((x, i) => {
          pushJson(x);
          lua.lua_rawseti(L, -2, i + 1);
        });
      } else {
        lua.lua_createtable(L, 0, Object.keys(v).length);
        for (const [k, x] of Object.entries(v)) {
          pushJson(x);
          lua.lua_setfield(L, -2, to_luastring(k));
        }
      }
    };

    // redis = { call = fn }
    lua.lua_createtable(L, 0, 1);
    lua.lua_pushcfunction(L, (LL: any) => {
      const n = lua.lua_gettop(LL);
      const args: string[] = [];
      for (let i = 1; i <= n; i++) args.push(to_jsstring(lua.lua_tostring(LL, i)));
      let result: string | number | false;
      try {
        result = this.redisCall(args[0], args.slice(1));
      } catch (e) {
        lua.lua_pushstring(LL, to_luastring(String((e as Error).message)));
        return lua.lua_error(LL);
      }
      if (result === false) lua.lua_pushboolean(LL, false);
      else if (typeof result === "number") lua.lua_pushinteger(LL, result);
      else lua.lua_pushstring(LL, to_luastring(result));
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring("call"));
    lua.lua_setglobal(L, to_luastring("redis"));

    // cjson = { decode = fn, null = sentinel }
    lua.lua_createtable(L, 0, 2);
    lua.lua_pushcfunction(L, (LL: any) => {
      const s = to_jsstring(lua.lua_tostring(LL, 1));
      try {
        // push into the *calling* state
        const saved = L;
        void saved;
        const parsed = JSON.parse(s);
        // pushJson writes to the outer L, which is the same Lua thread here
        pushJson(parsed);
        return 1;
      } catch (e) {
        lua.lua_pushstring(LL, to_luastring("cjson.decode: " + (e as Error).message));
        return lua.lua_error(LL);
      }
    });
    lua.lua_setfield(L, -2, to_luastring("decode"));
    lua.lua_pushlightuserdata(L, NULL_SENTINEL);
    lua.lua_setfield(L, -2, to_luastring("null"));
    lua.lua_setglobal(L, to_luastring("cjson"));

    // Redis ships Lua 5.1; keep the one 5.1-only name scripts might use.
    lauxlib.luaL_dostring(L, to_luastring("unpack = unpack or table.unpack"));

    if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK) {
      throw new Error("Lua compile error: " + to_jsstring(lua.lua_tostring(L, -1)));
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      throw new Error("Lua runtime error: " + to_jsstring(lua.lua_tostring(L, -1)));
    }
    let out: unknown = null;
    if (lua.lua_isnil(L, -1) || (lua.lua_isboolean(L, -1) && !lua.lua_toboolean(L, -1))) out = null;
    else if (lua.lua_type(L, -1) === lua.LUA_TSTRING) out = to_jsstring(lua.lua_tostring(L, -1));
    else if (lua.lua_isnumber(L, -1)) out = lua.lua_tonumber(L, -1);
    else out = null;
    // mimic Upstash's deserialization of the script's return value: a bare
    // id/marker string stays a string
    return typeof out === "string" ? this.decode(out) : out;
  }
}

export function installFakeRedis(): FakeRedis {
  const fake = new FakeRedis();
  (globalThis as unknown as { __amoruhRedis: unknown }).__amoruhRedis = fake;
  return fake;
}
