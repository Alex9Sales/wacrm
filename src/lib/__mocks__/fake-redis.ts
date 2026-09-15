// ------------------------------------------------------------------
// Shared in-memory ioredis stub for unit tests.
//
// Implements exactly the surface the Redis-backed rate limiter uses:
//   - eval(script, numKeys, key, windowMs) — the fixed-window Lua,
//     interpreted behaviourally (INCR + expire-on-first-hit + PTTL),
//     honouring the mocked clock so fake-timer tests work.
//   - keys(pattern) / del(...keys) — for __resetRateLimitForTests.
//
// Usage in a test file:
//   import { FakeRedis, redisStore } from "@/lib/__mocks__/fake-redis";
//   vi.mock("ioredis", () => ({ Redis: FakeRedis }));
//   // clear between tests: redisStore.clear()
// ------------------------------------------------------------------

interface StoreEntry {
  value: number;
  expireAt: number | null; // absolute ms, null = no TTL
}

export const redisStore = new Map<string, StoreEntry>();

function live(key: string): StoreEntry | undefined {
  const e = redisStore.get(key);
  if (!e) return undefined;
  if (e.expireAt !== null && e.expireAt <= Date.now()) {
    redisStore.delete(key);
    return undefined;
  }
  return e;
}

export class FakeRedis {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(..._args: any[]) {}
  on() {
    return this;
  }
  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    windowMs: string,
  ): Promise<[number, number]> {
    let e = live(key);
    if (!e) {
      e = { value: 0, expireAt: null };
      redisStore.set(key, e);
    }
    e.value += 1;
    const count = e.value;
    if (count === 1) {
      e.expireAt = Date.now() + Number(windowMs);
    }
    let pttl = e.expireAt === null ? -1 : e.expireAt - Date.now();
    if (pttl < 0) {
      e.expireAt = Date.now() + Number(windowMs);
      pttl = Number(windowMs);
    }
    return [count, pttl];
  }
  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, "");
    return [...redisStore.keys()].filter((k) => k.startsWith(prefix));
  }
  async exists(key: string): Promise<number> {
    return live(key) ? 1 : 0;
  }
  // set(key, value, "PX", ms) — only the TTL shape the Gmail backoff uses.
  async set(key: string, _value: string, mode?: string, ttl?: number): Promise<"OK"> {
    const expireAt = mode === "PX" && ttl ? Date.now() + Number(ttl) : null;
    redisStore.set(key, { value: 1, expireAt });
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (redisStore.delete(k)) n += 1;
    return n;
  }
}
