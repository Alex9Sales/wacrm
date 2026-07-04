// ============================================================
// Shared BullMQ connection options (Phase 5 CORE).
//
// We hand BullMQ a plain connection-options object (host/port/… derived
// from REDIS_URL) rather than a pre-built ioredis instance. BullMQ then
// creates and manages its own clients — this both matches BullMQ's
// recommended pattern AND avoids a type clash: bullmq bundles its own
// copy of ioredis, so passing an instance from the top-level `ioredis`
// dependency mismatches its `ConnectionOptions` type.
//
// BullMQ requires `maxRetriesPerRequest: null` on its blocking clients;
// it applies that itself when given options, but we set it explicitly for
// any ad-hoc client we build (e.g. the worker's Redis for KEYS scans).
//
// Next-independent (only ioredis + process.env) — safe to import from
// both the Next app and the standalone tsx worker.
// ============================================================

import { Redis, type RedisOptions } from 'ioredis';
import type { ConnectionOptions } from 'bullmq';

/** Parse REDIS_URL into ioredis connection options + BullMQ requirements. */
export function bullConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      'REDIS_URL is not set. Add it to .env.local (redis://host:port).',
    );
  }
  const parsed = new URL(url);
  const opts: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    // BullMQ mandates this on its blocking commands.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
  if (parsed.password) opts.password = decodeURIComponent(parsed.password);
  if (parsed.username) opts.username = decodeURIComponent(parsed.username);
  if (parsed.pathname && parsed.pathname.length > 1) {
    opts.db = Number(parsed.pathname.slice(1));
  }
  if (parsed.protocol === 'rediss:') opts.tls = {};
  return opts as ConnectionOptions;
}

/**
 * Build a raw ioredis client (for direct Redis calls the worker needs,
 * e.g. scanning for orphaned `outbound:*` queues on startup). Not for
 * BullMQ queue/worker construction — those take `bullConnection()`.
 */
export function createRedisClient(): Redis {
  return new Redis(bullConnection() as RedisOptions);
}
