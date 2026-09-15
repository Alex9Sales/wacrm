// ============================================================
// POST /api/v1/broadcasts/text — enqueue a humanized TEXT broadcast (the
// RecebIA-style drip) on a non-official channel. scope: broadcasts:send
//
// Unlike POST /api/v1/broadcasts (Meta template), this sends plain text with
// {{variables}}, paced across business hours (or "send now"). Recipients can
// be given as a CSV-style list ({phone,name}[]) — new numbers are upserted
// into contacts — or as existing contact_ids. Body:
//   {
//     "channel_id": "<waha/evo/evogo channel>",   // optional; defaults to
//                                                  //   the account's first
//                                                  //   non-official channel
//     "body_text": "Olá {{primeiro_nome|cliente}}…",
//     "media_url": "https://…", "media_type": "image",  // optional
//     "name": "Campanha X",                        // optional
//     "daily_cap": 50,                             // humanized drip cap/day
//     "send_now": false, "send_now_interval_min": 1,   // optional
//     "recipients": [{ "phone": "+5567…", "name": "Maria" }],  // OR
//     "contact_ids": ["<uuid>", …],
//     "skip_recent_duplicates": false              // optional (default false)
//   }
// Returns { data: { broadcast_id, total_recipients, skipped_duplicates } }.
//
// skip_recent_duplicates (15/09, GoLink: envios repetidos): true = tira quem
// já recebeu a mesma mensagem nas últimas 24 h; `skipped_duplicates` lista
// quem ficou de fora ([{ contact_id, name, last_sent_at }]). Padrão false pra
// integração existente não mudar de comportamento. Se TODOS já tinham
// recebido → 409 all_recipients_duplicate com a mesma lista em error.
// ============================================================

import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';

import { db, channels } from '@/db';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { getProvider } from '@/lib/channels/registry';
import type { ProviderId } from '@/lib/channels/provider';
import {
  enqueueTextBroadcast,
  upsertContactsByPhone,
} from '@/lib/broadcasts/text-broadcast';
import type { DuplicateSkip } from '@/lib/broadcasts/duplicate-sends';
import { logBroadcastEvent } from '@/lib/broadcasts/audit';

function toWireSkips(list: DuplicateSkip[] | undefined) {
  return (list ?? []).map((d) => ({
    contact_id: d.contactId,
    name: d.name,
    last_sent_at: d.lastSentAt,
  }));
}

/** The account's first non-official (needsJitter) channel — the default
 *  sender when the caller omits channel_id. */
async function firstNonOfficialChannel(
  accountId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: channels.id, provider: channels.provider })
    .from(channels)
    .where(eq(channels.accountId, accountId))
    .orderBy(asc(channels.createdAt));
  for (const r of rows) {
    if (getProvider(r.provider as ProviderId).capabilities.needsJitter) {
      return r.id;
    }
  }
  return null;
}

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

    // Channel: explicit or default to the account's first non-official one.
    let channelId =
      typeof body.channel_id === 'string' ? body.channel_id : null;
    if (!channelId) {
      channelId = await firstNonOfficialChannel(ctx.accountId);
      if (!channelId) {
        return fail(
          'bad_request',
          'No non-official channel (WAHA/Evolution/EvoGo) connected — pass channel_id',
          400,
        );
      }
    }

    const userId = await resolveAuditUserId(ctx.accountId);

    // Resolve recipients: CSV-style {phone,name}[] (upsert) or contact_ids.
    let recipientContactIds: string[] = [];
    if (Array.isArray(body.recipients) && body.recipients.length > 0) {
      const rows = body.recipients
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({
          phone: typeof r.phone === 'string' ? r.phone : '',
          name: typeof r.name === 'string' ? r.name : null,
        }))
        .filter((r) => r.phone);
      recipientContactIds = await upsertContactsByPhone(
        ctx.accountId,
        userId,
        rows,
      );
    } else if (Array.isArray(body.contact_ids) && body.contact_ids.length > 0) {
      const ids = body.contact_ids.filter(
        (v): v is string => typeof v === 'string',
      );
      // enqueueTextBroadcast re-checks ownership, but filtering here keeps the
      // audit `audienceFilter` honest to what actually resolved.
      recipientContactIds = ids;
    } else {
      return fail(
        'bad_request',
        "Provide 'recipients' ([{phone,name}]) or 'contact_ids'",
        400,
      );
    }

    if (recipientContactIds.length === 0) {
      return fail('bad_request', 'No valid recipients', 400);
    }

    const result = await enqueueTextBroadcast(ctx.accountId, userId, {
      name: typeof body.name === 'string' ? body.name : null,
      channelId,
      bodyText: typeof body.body_text === 'string' ? body.body_text : '',
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      mediaType:
        typeof body.media_type === 'string'
          ? (body.media_type as 'image')
          : null,
      mediaFilename:
        typeof body.media_filename === 'string' ? body.media_filename : null,
      dailyCap:
        body.daily_cap != null ? Number(body.daily_cap) : undefined,
      sendNow: body.send_now === true,
      sendNowIntervalMin:
        body.send_now_interval_min != null
          ? Number(body.send_now_interval_min)
          : undefined,
      recipientContactIds,
      audienceFilter: { source: 'api/v1', via: Array.isArray(body.recipients) ? 'recipients' : 'contact_ids' },
      // Opt-in: integrações existentes seguem mandando pra todos.
      skipRecentDuplicates: body.skip_recent_duplicates === true,
    });

    if (!result.broadcastId && (result.skippedDuplicates?.length ?? 0) > 0) {
      return NextResponse.json(
        {
          error: {
            code: 'all_recipients_duplicate',
            message: result.error ?? 'All recipients already received this message in the last 24 h',
            skipped_duplicates: toWireSkips(result.skippedDuplicates),
          },
        },
        { status: 409 },
      );
    }
    if (result.error || !result.broadcastId) {
      return fail('bad_request', result.error ?? 'Failed to create broadcast', 400);
    }
    logBroadcastEvent({
      action: 'create',
      broadcastId: result.broadcastId,
      accountId: ctx.accountId,
      userId,
      role: 'api',
      channelId,
      extra: { source: 'api/v1', total: result.totalRecipients, skipped: result.skippedDuplicates?.length ?? 0 },
    });
    return ok(
      {
        broadcast_id: result.broadcastId,
        total_recipients: result.totalRecipients,
        skipped_duplicates: toWireSkips(result.skippedDuplicates),
      },
      201,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
