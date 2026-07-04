/**
 * Redis-backed per-key rate limiter (fixed-window counter).
 *
 * Why Redis and not the old in-process Map: this app runs as multiple
 * containers behind Traefik — at minimum a `web` and a `worker` from the
 * same image, and potentially several `web` replicas. A per-process Map
 * silently multiplies every budget by the replica count (each process
 * keeps its own counter), so the limit stops meaning anything. A shared
 * Redis counter is the single source of truth every container agrees on.
 *
 * Window model: fixed-window. Each identifier gets a fresh N-request
 * budget per `windowMs`. We store one integer key per (identifier,
 * window) with a TTL equal to the window — INCR creates it at 1, we set
 * EXPIRE on that first hit, and Redis reaps it when the window closes.
 * A tiny Lua script makes the INCR + first-hit-EXPIRE + read-TTL a single
 * atomic round-trip, so two concurrent requests can't both "win" the
 * expiry set and leak a key without a TTL.
 *
 * FAIL-OPEN: if Redis is unreachable (down, netsplit, cold container),
 * `checkRateLimit` allows the request rather than hard-blocking the whole
 * app on an infra hiccup. Rate limiting is a guardrail, not an authz
 * gate — degrading it open is the correct availability trade. Every
 * fail-open is logged so a Redis outage is visible, not silent.
 *
 * The exported surface (RateLimitResult shape, rateLimitResponse,
 * RATE_LIMITS, __resetRateLimitForTests) is unchanged from the in-memory
 * version — `checkRateLimit` is now async (returns a Promise), so its
 * ~15 call sites `await` it; every one already sits in an async handler.
 */

import { NextResponse } from 'next/server';
import { Redis, type RedisOptions } from 'ioredis';

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Window size, milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  /** Unix ms when the bucket refills. */
  reset: number;
  limit: number;
}

// ------------------------------------------------------------------
// Dedicated Redis client for rate limiting.
//
// Separate from BullMQ's connection (which mandates
// `maxRetriesPerRequest: null` on its blocking clients) — here we WANT a
// bounded retry so a dead Redis surfaces as a fast rejected command we
// catch and fail-open on, rather than a command that hangs forever.
// Parses the same REDIS_URL the rest of the stack uses.
// ------------------------------------------------------------------

let _client: Redis | null = null;

function getRedis(): Redis | null {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    // No Redis configured at all — fail open, warn once per cold start.
    // eslint-disable-next-line no-console
    console.warn(
      '[rate-limit] REDIS_URL not set — rate limiting is DISABLED (fail-open).',
    );
    return null;
  }

  try {
    const parsed = new URL(url);
    const opts: RedisOptions = {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
      // Bounded retries so a command against a dead Redis rejects quickly
      // and we fail open, instead of queueing forever.
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      // Cap reconnect backoff so a recovering Redis is picked back up
      // without a thundering-herd of reconnects.
      retryStrategy: (times) => Math.min(times * 200, 2000),
      // Don't let queued commands pile up while offline — reject fast.
      enableOfflineQueue: false,
      lazyConnect: false,
      connectionName: 'crmfluxia-ratelimit',
    };
    if (parsed.password) opts.password = decodeURIComponent(parsed.password);
    if (parsed.username) opts.username = decodeURIComponent(parsed.username);
    if (parsed.pathname && parsed.pathname.length > 1) {
      opts.db = Number(parsed.pathname.slice(1));
    }
    if (parsed.protocol === 'rediss:') opts.tls = {};

    _client = new Redis(opts);
    // A connection-level error must not throw out of an event loop tick
    // and crash the process — log and let per-command catches fail open.
    _client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[rate-limit] redis connection error:', err.message);
    });
    return _client;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rate-limit] failed to construct redis client:', err);
    return null;
  }
}

// Atomic fixed-window counter.
//   KEYS[1] = bucket key
//   ARGV[1] = window in ms (for PEXPIRE on first hit)
// Returns: { count, pttl } — count after this hit, and remaining TTL ms.
// EXPIRE is set only on the first INCR (count == 1) so we don't slide the
// window forward on every request. If somehow the key exists without a
// TTL (-1), we repair it.
const WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
return {count, pttl}
`;

/**
 * Check and consume one unit of the budget for `key`.
 *
 * Async (Redis round-trip). Fails OPEN: on any Redis error the request is
 * allowed (success: true) and the miss is logged. Returns the same shape
 * the in-memory limiter did, so `rateLimitResponse` and every call site
 * are unchanged apart from awaiting.
 */
export async function checkRateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): Promise<RateLimitResult> {
  const now = Date.now();
  const redis = getRedis();

  // No client (unconfigured or construction failed) → fail open.
  if (!redis) {
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }

  try {
    const bucketKey = `ratelimit:${key}`;
    const res = (await redis.eval(
      WINDOW_LUA,
      1,
      bucketKey,
      String(windowMs),
    )) as [number, number];

    const count = Number(res[0]);
    const pttl = Number(res[1]);
    const reset = now + (pttl >= 0 ? pttl : windowMs);

    if (count > limit) {
      return { success: false, remaining: 0, reset, limit };
    }
    return {
      success: true,
      remaining: Math.max(0, limit - count),
      reset,
      limit,
    };
  } catch (err) {
    // FAIL OPEN — a Redis hiccup must not take the whole app down.
    // eslint-disable-next-line no-console
    console.error(
      `[rate-limit] redis error for key "${key}" — failing open:`,
      err instanceof Error ? err.message : err,
    );
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Preconfigured budgets, tweak here not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second
   *  sustained, comfortable for a live human typing. */
  send: { limit: 60, windowMs: 60_000 },
  /** Broadcast dispatch. 5/min per user — even a 1 000-recipient
   *  broadcast is one call; this caps the rate at which a single user
   *  can launch campaigns, not the messages inside one. */
  broadcast: { limit: 5, windowMs: 60_000 },
  /** Reaction add/swap/remove. More permissive than send — users
   *  fidget with reactions and a single "swap" is actually two calls
   *  (remove + add) under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). 30/min lets a forwarded link
   *  retry a handful of times under flaky connectivity without
   *  enabling brute-force token enumeration. With 256-bit tokens the
   *  enumeration risk is theoretical; this is belt-and-braces. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). Tighter than peek —
   *  successful redemption mutates two profiles and an invite row, so
   *  the abuse surface is "spam join attempts." */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Admin-only account / member-management actions: create/revoke
   *  invitation, rename account, change member role, remove member,
   *  transfer ownership. 30/min per user is comfortably above any
   *  realistic legitimate use (the Members tab is a clicks-only UI)
   *  while still bounding accidental abuse from a script run in a
   *  loop or a compromised admin session spamming role flips. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Public REST API (`/api/v1/*`), keyed per API key. 120/min ≈ 2
   *  req/s sustained — comfortable for a polling integration or an
   *  automation firing on inbound events, while bounding a runaway
   *  script. Shared across every container via Redis, so the budget
   *  holds no matter how many web replicas serve the key. */
  publicApi: { limit: 120, windowMs: 60_000 },
  /** AI draft-reply generation, per user. 20/min is generous for an
   *  agent clicking "Draft with AI" while working a thread, and bounds
   *  spend on the account's own LLM key against an accidental
   *  hold-down / script. */
  aiDraft: { limit: 20, windowMs: 60_000 },
  /** AI draft-reply generation, per account. Caps the WHOLE team's
   *  draws on the one shared BYO provider key — without this, N agents
   *  each under their per-user limit could still stampede the account's
   *  key past the provider's own rate limit. 60/min ≈ three busy agents
   *  drafting flat-out. */
  aiDraftAccount: { limit: 60, windowMs: 60_000 },
} as const;

/** Test-only helper. Flushes this process's rate-limit keys from Redis so
 *  unit tests don't leak buckets across files. In the mocked-ioredis test
 *  setup it clears the in-memory store the mock keeps. Not wired up in
 *  production code. Best-effort: swallows errors. */
export async function __resetRateLimitForTests(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const keys = await redis.keys('ratelimit:*');
    if (keys.length) await redis.del(...keys);
  } catch {
    // ignore — tests that need a clean slate mock ioredis directly.
  }
}
