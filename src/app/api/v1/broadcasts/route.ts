// ============================================================
// POST /api/v1/broadcasts — launch a template broadcast
// (scope: broadcasts:send).
//
// Body:
//   {
//     "name": "July promo",                 // optional label
//     "template_name": "promo_july",        // required, approved template
//     "template_language": "en_US",         // optional (default en_US)
//     "channel_id": "…",                     // optional; default channel if omitted
//     "scheduled_at": "2026-07-10T12:00:00Z",// optional ISO; future ⇒ scheduled
//     "recipients": [                        // required, 1..50000
//       { "to": "+14155550123", "params": ["Jane"] },
//       { "to": "+14155550124" }
//     ]
//   }
//
// The broadcast + its recipient rows are persisted synchronously, then a
// durable BullMQ dispatch job is enqueued (delayed when scheduled). A
// separate worker (`npm run worker`) drains it with per-channel
// throttling, retries, and idempotency. Poll `GET /api/v1/broadcasts/{id}`
// for progress.
//
// Response (202):
//   { "data": { "broadcast_id", "status": "sending" | "scheduled",
//               "total_recipients", "accepted", "rejected",
//               "scheduled_at": string | null } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  createBroadcast,
  BroadcastError,
} from '@/lib/whatsapp/broadcast-core';
import { enqueueBroadcastDispatch } from '@/lib/queue/queues';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    const auditUserId = await resolveAuditUserId(ctx.accountId);

    const plan = await createBroadcast(ctx.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : null,
      channelId: typeof body.channel_id === 'string' ? body.channel_id : null,
      scheduledAt:
        typeof body.scheduled_at === 'string' ? body.scheduled_at : null,
      recipients: recipients.map((r) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        params: Array.isArray(r?.params) ? r.params : undefined,
      })),
    });

    // Enqueue a durable dispatch job. Delayed when scheduled so the
    // worker picks it up at scheduled_at; the worker then fans recipients
    // out onto the channel's throttled outbound queue. Idempotent
    // (jobId = dispatch:{broadcastId}).
    const delayMs = plan.scheduledAtMs
      ? Math.max(0, plan.scheduledAtMs - Date.now())
      : undefined;
    await enqueueBroadcastDispatch(plan.broadcastId, { delayMs });

    return ok(
      {
        broadcast_id: plan.broadcastId,
        status: plan.status,
        total_recipients: plan.planned.length,
        accepted: plan.planned.length,
        rejected: plan.rejected,
        scheduled_at: plan.scheduledAtMs
          ? new Date(plan.scheduledAtMs).toISOString()
          : null,
      },
      202
    );
  } catch (err) {
    if (err instanceof BroadcastError) {
      return fail(err.code, err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
