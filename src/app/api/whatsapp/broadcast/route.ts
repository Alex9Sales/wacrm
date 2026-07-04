import { NextResponse } from 'next/server'

import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { createBroadcast, BroadcastError } from '@/lib/whatsapp/broadcast-core'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { enqueueBroadcastDispatch } from '@/lib/queue/queues'

/**
 * POST /api/whatsapp/broadcast — dashboard broadcast launcher.
 *
 * Phase 5 CORE: this route no longer sends inline. It persists the
 * broadcast + recipient rows via `createBroadcast` and enqueues a durable
 * BullMQ dispatch job; a separate worker (`npm run worker`) drains it with
 * per-channel throttling, retries, and idempotency. Poll
 * `GET /api/v1/broadcasts/{id}` for progress + counts.
 *
 * Two input shapes are accepted (unchanged):
 *
 *   NEW (preferred — per-recipient variable substitution):
 *     { recipients: [{ phone, params?, messageParams? }],
 *       template_name, template_language?, channel_id?, scheduled_at? }
 *
 *   LEGACY (all phones share the same params):
 *     { phone_numbers: string[], template_params?: string[],
 *       template_name, template_language?, channel_id?, scheduled_at? }
 *
 * Response (202) — the shape changed from the old per-phone results to an
 * async acknowledgement (documented for the broadcast UI agent):
 *   { success: true, broadcast_id, status: 'sending'|'scheduled',
 *     total, accepted, rejected, scheduled_at }
 */
interface NewRecipient {
  phone: string
  /** Body variable values, one per {{N}}. */
  params?: string[]
  /** Structured per-send values (header text/media, button values). */
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  try {
    let ctx: AccountContext
    try {
      ctx = await getCurrentAccount()
    } catch (err) {
      return toErrorResponse(err)
    }
    const accountId = ctx.accountId

    // Per-user broadcast budget — limits how often a user can *start* a
    // campaign (the fan-out itself is now the worker's job).
    const limit = await checkRateLimit(`broadcast:${ctx.userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      channel_id,
      scheduled_at,
    } = body

    // Normalize to {phone, params, messageParams} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    const auditUserId = await resolveAuditUserId(accountId)

    const plan = await createBroadcast(accountId, auditUserId, {
      templateName: template_name,
      templateLanguage:
        typeof template_language === 'string' ? template_language : null,
      channelId: typeof channel_id === 'string' ? channel_id : null,
      scheduledAt: typeof scheduled_at === 'string' ? scheduled_at : null,
      recipients: recipients.map((r) => ({
        to: typeof r.phone === 'string' ? r.phone : '',
        params: Array.isArray(r.params) ? r.params : undefined,
        messageParams: r.messageParams,
      })),
    })

    const delayMs = plan.scheduledAtMs
      ? Math.max(0, plan.scheduledAtMs - Date.now())
      : undefined
    await enqueueBroadcastDispatch(plan.broadcastId, { delayMs })

    return NextResponse.json(
      {
        success: true,
        broadcast_id: plan.broadcastId,
        status: plan.status,
        total: plan.planned.length,
        accepted: plan.planned.length,
        rejected: plan.rejected,
        scheduled_at: plan.scheduledAtMs
          ? new Date(plan.scheduledAtMs).toISOString()
          : null,
      },
      { status: 202 }
    )
  } catch (error) {
    if (error instanceof BroadcastError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      )
    }
    if (error instanceof ContactError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      )
    }
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    )
  }
}
