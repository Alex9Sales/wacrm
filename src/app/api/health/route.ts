// ============================================================
// Liveness / readiness probe.
//
// GET /api/health          → cheap liveness. `{ ok: true, ts }`, 200.
//   No auth, no DB, no Redis — just "the Node process is up and serving
//   HTTP." This is what Docker HEALTHCHECK and Traefik/Coolify should hit;
//   it must never depend on a downstream that could be transiently down,
//   or a healthy web container gets killed during a DB blip.
//
// GET /api/health?deep=1   → readiness. Pings Postgres (SELECT 1) and
//   Redis (PING) and reports each. Returns 200 only if BOTH are healthy,
//   503 otherwise. Use this for a dashboard / manual check, NOT for the
//   container liveness probe.
//
// runtime nodejs (needs pg + ioredis), dynamic (never cached/prerendered).
// ============================================================

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function pingDb(): Promise<{ ok: boolean; error?: string }> {
  try {
    // Import lazily so the cheap liveness path never touches the pg pool.
    const { db } = await import('@/db');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`SELECT 1`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function pingRedis(): Promise<{ ok: boolean; error?: string }> {
  const url = process.env.REDIS_URL;
  if (!url) return { ok: false, error: 'REDIS_URL not set' };
  let client: import('ioredis').Redis | null = null;
  try {
    const { Redis } = await import('ioredis');
    const parsed = new URL(url);
    client = new Redis({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      db: parsed.pathname && parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : undefined,
      tls: parsed.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 2000,
    });
    await client.connect();
    const pong = await client.ping();
    return { ok: pong === 'PONG' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Don't leak a connection per probe.
    if (client) client.disconnect();
  }
}

export async function GET(request: Request) {
  const ts = new Date().toISOString();
  const { searchParams } = new URL(request.url);

  // Default: pure liveness. Cheap, dependency-free, always 200 if we're up.
  if (searchParams.get('deep') !== '1') {
    return NextResponse.json({ ok: true, ts }, { status: 200 });
  }

  // Deep: readiness against Postgres + Redis.
  const [database, redis] = await Promise.all([pingDb(), pingRedis()]);
  const ok = database.ok && redis.ok;
  return NextResponse.json(
    { ok, ts, checks: { database, redis } },
    { status: ok ? 200 : 503 },
  );
}
