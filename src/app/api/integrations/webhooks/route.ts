// ============================================================
// /api/integrations/webhooks — session-authed webhook management.
//
//   GET  — list this account's webhook endpoints (safe columns; the
//          signing secret is never returned, only a masked hint that
//          one exists).
//   POST — register an endpoint and return the freshly-generated
//          signing secret in plaintext EXACTLY ONCE so the user can
//          paste it into n8n/Make. We persist only an encrypted copy.
//
// This mirrors the API-key-authed CRUD at /api/v1/webhooks, but
// authenticates with the cookie session (getCurrentAccount /
// requireRole) so the Settings → Integrações UI needs no API key.
//
// Listing is open to any member (the roster is not secret); creating
// is admin+ (an endpoint receives event payloads), enforced by
// `requireRole('admin')`.
// ============================================================

import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';

import { db, webhookEndpoints } from '@/db';
import { firstOrNull } from '@/db/helpers';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  serializeWebhookEndpoint,
  generateWebhookSecret,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// Columns safe to return over the session API — everything except the
// (encrypted) `secret`. Mirrors src/app/api/v1/webhooks/route.ts.
const WEBHOOK_PUBLIC_SELECT = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  is_active: webhookEndpoints.isActive,
  last_delivery_at: webhookEndpoints.lastDeliveryAt,
  failure_count: webhookEndpoints.failureCount,
  created_at: webhookEndpoints.createdAt,
};

export async function GET() {
  try {
    // Any member can view the roster; we just need a resolved account
    // context to scope the query. The secret is never in the response.
    const ctx = await getCurrentAccount();

    let data;
    try {
      data = await db
        .select(WEBHOOK_PUBLIC_SELECT)
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.accountId, ctx.accountId))
        .orderBy(desc(webhookEndpoints.createdAt));
    } catch (err) {
      console.error('[GET /api/integrations/webhooks] fetch error:', err);
      return NextResponse.json(
        { error: 'Failed to load webhooks' },
        { status: 500 }
      );
    }

    // Every endpoint always has a secret (NOT NULL), so `has_secret` is
    // effectively always true — but keep it explicit so the UI can show
    // a "segredo configurado" hint without ever seeing the value.
    return NextResponse.json({
      webhooks: data.map((r) => ({
        ...serializeWebhookEndpoint(r as Record<string, unknown>),
        has_secret: true,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = await checkRateLimit(
      `admin:webhookCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const url = normalizeWebhookUrl(body.url);
    if (!url) {
      return NextResponse.json(
        { error: "'url' deve ser uma URL https:// válida" },
        { status: 400 }
      );
    }

    const events = normalizeEvents(body.events);
    if (!events) {
      return NextResponse.json(
        {
          error:
            "'events' deve ser uma lista não vazia de eventos conhecidos",
        },
        { status: 400 }
      );
    }

    const secret = generateWebhookSecret();

    let created;
    try {
      created = firstOrNull(
        await db
          .insert(webhookEndpoints)
          .values({
            accountId: ctx.accountId,
            createdBy: ctx.userId,
            url,
            secret: encrypt(secret),
            events,
          })
          .returning(WEBHOOK_PUBLIC_SELECT)
      );
    } catch (err) {
      console.error('[POST /api/integrations/webhooks] insert error:', err);
      return NextResponse.json(
        { error: 'Failed to create webhook' },
        { status: 500 }
      );
    }

    if (!created) {
      console.error('[POST /api/integrations/webhooks] insert returned no row');
      return NextResponse.json(
        { error: 'Failed to create webhook' },
        { status: 500 }
      );
    }

    // Secret shown exactly once — the user copies it into their flow.
    return NextResponse.json(
      {
        webhook: {
          ...serializeWebhookEndpoint(created as Record<string, unknown>),
          has_secret: true,
        },
        secret,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
