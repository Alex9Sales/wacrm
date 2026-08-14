// ============================================================
// /api/integrations/webhooks/{id} — session-authed per-endpoint ops.
//
//   PATCH  — toggle active, update events/url.
//   DELETE — remove an endpoint.
//
// Mirrors src/app/api/v1/webhooks/[id]/route.ts but authenticates with
// the cookie session (requireRole('admin')). All account-scoped: a
// foreign id touches nothing and returns 404 (never 403). The signing
// secret is never returned — it is shown once at creation only.
// ============================================================

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db, webhookEndpoints, channels } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  serializeWebhookEndpoint,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints';

const WEBHOOK_PUBLIC_SELECT = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  channel_id: webhookEndpoints.channelId,
  is_active: webhookEndpoints.isActive,
  last_delivery_at: webhookEndpoints.lastDeliveryAt,
  failure_count: webhookEndpoints.failureCount,
  created_at: webhookEndpoints.createdAt,
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

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

    const updates: Partial<{
      url: string;
      events: string[];
      channelId: string | null;
      isActive: boolean;
      failureCount: number;
    }> = {};

    // Canal (caixa de entrada): null = todos. Se veio um id, tem que ser da conta.
    if ('channel_id' in body) {
      const raw = body.channel_id;
      if (raw === null || raw === '') {
        updates.channelId = null;
      } else if (typeof raw === 'string') {
        const ch = firstOrNull(
          await db
            .select({ id: channels.id })
            .from(channels)
            .where(and(eq(channels.id, raw), eq(channels.accountId, ctx.accountId)))
            .limit(1)
        );
        if (!ch) {
          return NextResponse.json(
            { error: 'Canal inválido' },
            { status: 400 }
          );
        }
        updates.channelId = raw;
      } else {
        return NextResponse.json(
          { error: "'channel_id' deve ser um id de canal ou null" },
          { status: 400 }
        );
      }
    }

    if ('url' in body) {
      const url = normalizeWebhookUrl(body.url);
      if (!url) {
        return NextResponse.json(
          { error: "'url' deve ser uma URL https:// válida" },
          { status: 400 }
        );
      }
      updates.url = url;
    }

    if ('events' in body) {
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
      updates.events = events;
    }

    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') {
        return NextResponse.json(
          { error: "'is_active' deve ser um booleano" },
          { status: 400 }
        );
      }
      updates.isActive = body.is_active;
      // Re-enabling a disabled endpoint clears its failure streak so it
      // isn't instantly re-disabled by a single stale failure.
      if (body.is_active === true) updates.failureCount = 0;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'Nenhum campo atualizável informado' },
        { status: 400 }
      );
    }

    // Scope the update by account_id so a foreign id touches nothing;
    // the returned row (null when unmatched) drives the 404.
    let data;
    try {
      data = firstOrNull(
        await db
          .update(webhookEndpoints)
          .set(updates)
          .where(
            and(
              eq(webhookEndpoints.id, id),
              eq(webhookEndpoints.accountId, ctx.accountId)
            )
          )
          .returning(WEBHOOK_PUBLIC_SELECT)
      );
    } catch (err) {
      console.error('[PATCH /api/integrations/webhooks/:id] update error:', err);
      return NextResponse.json(
        { error: 'Failed to update webhook' },
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({
      webhook: {
        ...serializeWebhookEndpoint(data as Record<string, unknown>),
        has_secret: true,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

    let data;
    try {
      data = firstOrNull(
        await db
          .delete(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.id, id),
              eq(webhookEndpoints.accountId, ctx.accountId)
            )
          )
          .returning({ id: webhookEndpoints.id })
      );
    } catch (err) {
      console.error('[DELETE /api/integrations/webhooks/:id] delete error:', err);
      return NextResponse.json(
        { error: 'Failed to delete webhook' },
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({ id: data.id, deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
