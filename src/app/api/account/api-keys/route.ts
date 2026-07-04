// ============================================================
// /api/account/api-keys
//
//   GET  — list this account's API keys (safe columns only).
//   POST — mint a new key.
//
// These are the *dashboard* endpoints for managing keys, so they
// authenticate the normal way (cookie session). Listing is open to
// any member (viewer+) — the roster is not secret; the secret (the
// key itself) is never in it. Minting is admin+ (a key hands out
// capabilities), enforced by `requireRole('admin')`.
//
// IMPORTANT: the plaintext key is returned exactly ONCE, in the POST
// response. We persist only its SHA-256 hash, so neither GET nor any
// future endpoint can resurface it — same one-time-reveal contract
// as invite links. If the admin loses it, they revoke and re-issue.
// ============================================================

import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';

import { db, apiKeys } from '@/db';
import { firstOrNull } from '@/db/helpers';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { generateApiKey } from '@/lib/api-keys/keys';
import { normalizeScopes } from '@/lib/api-keys/scopes';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MAX_NAME_LEN = 80;
// Hard ceiling on caller-supplied expiry (1 year), mirroring the
// invite-link clamp. NULL/absent = never expires.
const MAX_EXPIRY_DAYS = 365;

// Columns safe to expose. `key_hash` is deliberately excluded — it
// never leaves the server.
const SAFE_COLUMNS = {
  id: apiKeys.id,
  name: apiKeys.name,
  key_prefix: apiKeys.keyPrefix,
  scopes: apiKeys.scopes,
  last_used_at: apiKeys.lastUsedAt,
  expires_at: apiKeys.expiresAt,
  revoked_at: apiKeys.revokedAt,
  created_at: apiKeys.createdAt,
};

export async function GET() {
  try {
    // Any member can view the roster; we just need a resolved
    // account context to scope the query.
    const ctx = await getCurrentAccount();

    let data;
    try {
      data = await db
        .select(SAFE_COLUMNS)
        .from(apiKeys)
        .where(eq(apiKeys.accountId, ctx.accountId))
        .orderBy(desc(apiKeys.createdAt));
    } catch (err) {
      console.error('[GET /api/account/api-keys] fetch error:', err);
      return NextResponse.json(
        { error: 'Failed to load API keys' },
        { status: 500 }
      );
    }

    return NextResponse.json({ keys: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = await checkRateLimit(
      `admin:apiKeyCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      scopes?: unknown;
      expiresInDays?: unknown;
    } | null;

    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!rawName) {
      return NextResponse.json(
        { error: "'name' is required" },
        { status: 400 }
      );
    }
    if (rawName.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 }
      );
    }

    // Scopes default to none if omitted — that yields a key that can
    // only call the scope-free endpoints (e.g. GET /api/v1/me).
    const scopes = normalizeScopes(body?.scopes ?? []);
    if (scopes === null) {
      return NextResponse.json(
        { error: "'scopes' must be an array of known scope strings" },
        { status: 400 }
      );
    }

    let expiresAt: string | null = null;
    const rawExpiry = body?.expiresInDays;
    if (
      typeof rawExpiry === 'number' &&
      Number.isFinite(rawExpiry) &&
      rawExpiry > 0
    ) {
      const days = Math.min(Math.floor(rawExpiry), MAX_EXPIRY_DAYS);
      expiresAt = new Date(
        Date.now() + days * 24 * 60 * 60 * 1000
      ).toISOString();
    }

    const { plaintext, hash, prefix } = generateApiKey();

    let data;
    try {
      data = firstOrNull(
        await db
          .insert(apiKeys)
          .values({
            accountId: ctx.accountId,
            createdBy: ctx.userId,
            name: rawName,
            keyPrefix: prefix,
            keyHash: hash,
            scopes,
            expiresAt,
          })
          .returning(SAFE_COLUMNS)
      );
    } catch (err) {
      console.error('[POST /api/account/api-keys] insert error:', err);
      return NextResponse.json(
        { error: 'Failed to create API key' },
        { status: 500 }
      );
    }
    if (!data) {
      console.error('[POST /api/account/api-keys] insert returned no row');
      return NextResponse.json(
        { error: 'Failed to create API key' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        key: data,
        // Plaintext — shown to the admin exactly once.
        plaintext,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
