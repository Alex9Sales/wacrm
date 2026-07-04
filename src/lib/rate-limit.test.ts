import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis, redisStore as store } from "./__mocks__/fake-redis";

// Mock ioredis with a tiny in-memory Redis (see fake-redis.ts) that
// interprets the limiter's fixed-window Lua behaviourally, honouring PTTL
// expiry against the mocked clock. Keeps these tests hermetic (no real
// Redis) while exercising the real semantics: INCR, expire-on-first-hit,
// reject past the cap, fresh window after the TTL elapses, and fail-open.
vi.mock("ioredis", async () => {
  const { FakeRedis: R } = await import("./__mocks__/fake-redis");
  return { Redis: R };
});

// Ensure the limiter constructs its client (REDIS_URL must be present).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const {
  __resetRateLimitForTests,
  checkRateLimit,
  rateLimitResponse,
} = await import("./rate-limit");

const OPTS = { limit: 3, windowMs: 60_000 };

describe("checkRateLimit", () => {
  beforeEach(async () => {
    store.clear();
    await __resetRateLimitForTests();
  });

  it("permits the first request and decrements remaining", async () => {
    const result = await checkRateLimit("user:1", OPTS);
    expect(result).toMatchObject({
      success: true,
      remaining: 2,
      limit: 3,
    });
    expect(result.reset).toBeGreaterThan(Date.now());
  });

  it("permits exactly `limit` requests then rejects the next", async () => {
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    const over = await checkRateLimit("user:1", OPTS);
    expect(over.success).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("keeps separate counters per key", async () => {
    await checkRateLimit("user:1", OPTS);
    await checkRateLimit("user:1", OPTS);
    await checkRateLimit("user:1", OPTS);
    // user:1 is at the cap, user:2 should still be unaffected.
    const other = await checkRateLimit("user:2", OPTS);
    expect(other.success).toBe(true);
    expect(other.remaining).toBe(2);
  });

  it("opens a fresh window after `windowMs` elapses", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-05-01T00:00:00Z").getTime();
      vi.setSystemTime(t0);
      store.clear();

      await checkRateLimit("user:1", OPTS);
      await checkRateLimit("user:1", OPTS);
      await checkRateLimit("user:1", OPTS);
      expect((await checkRateLimit("user:1", OPTS)).success).toBe(false);

      // Jump just past the window.
      vi.setSystemTime(t0 + OPTS.windowMs + 1);
      const refreshed = await checkRateLimit("user:1", OPTS);
      expect(refreshed.success).toBe(true);
      expect(refreshed.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("checkRateLimit fail-open", () => {
  it("allows the request when Redis throws", async () => {
    const spy = vi
      .spyOn(FakeRedis.prototype, "eval")
      .mockRejectedValueOnce(new Error("connection refused"));
    const result = await checkRateLimit("user:fail", OPTS);
    expect(result.success).toBe(true);
    expect(result.limit).toBe(3);
    spy.mockRestore();
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 with retry / X-RateLimit headers", async () => {
    const reset = Date.now() + 30_000;
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset,
      limit: 60,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/rate limit/i);
  });

  it("clamps Retry-After to a minimum of 1 second", () => {
    // Reset already in the past — the ceiling math would otherwise give 0.
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset: Date.now() - 5_000,
      limit: 10,
    });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });
});

describe("RATE_LIMITS presets", () => {
  it("send and broadcast budgets are independent", async () => {
    const { RATE_LIMITS } = await import("./rate-limit");
    expect(RATE_LIMITS.send.limit).toBeGreaterThan(RATE_LIMITS.broadcast.limit);
    expect(RATE_LIMITS.send.windowMs).toBe(60_000);
    expect(RATE_LIMITS.broadcast.windowMs).toBe(60_000);
  });
});

afterEach(() => {
  store.clear();
});
