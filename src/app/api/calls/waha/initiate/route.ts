// ============================================================
// POST /api/calls/waha/initiate — start an OUTBOUND unofficial WhatsApp voice
// call (business → customer) through the waha-voip engine. Body: { to }.
//
// Unlike the Meta path, the SDP is NOT sent here: waha-voip places the call
// first (which rings the customer), then the browser negotiates its mic/audio
// separately via POST /api/calls/waha/{callId}/webrtc. So this route just
// resolves the canonical chatId (the LID fix) and calls /calls/start.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, callLogs, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  wahaCallsForAccount,
  wahaCallsForChannel,
  wahaCallsPost,
  resolveCallChatId,
} from '@/lib/channels/waha-calls'

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    // Master switch: when the admin disables CRM calling, block outbound too
    // (not just the UI buttons — a stale tab must not be able to dial).
    const settings = await getAccountSettings(ctx.accountId)
    if (!settings.crmCallingEnabled) {
      return NextResponse.json(
        {
          error:
            'Ligações desativadas pelo administrador. Reative em Configurações → Notificações.',
          code: 'calling_disabled',
        },
        { status: 403 },
      )
    }

    const body = (await request.json().catch(() => ({}))) as {
      to?: string
      channelId?: string
    }
    if (!body.to) {
      return NextResponse.json({ error: 'to required' }, { status: 400 })
    }

    // Unified mode: the conversation's channel IS the voice engine, so the
    // call goes out from that channel's number. Env/account = pilot fallback.
    const coords =
      (body.channelId
        ? await wahaCallsForChannel(ctx.accountId, body.channelId)
        : null) ?? (await wahaCallsForAccount(ctx.accountId))
    if (!coords) {
      return NextResponse.json(
        { error: 'No WAHA calls engine configured' },
        { status: 400 },
      )
    }

    // LID fix — resolve to the canonical chatId or the call never rings.
    const chatId = await resolveCallChatId(coords, body.to)
    if (!chatId) {
      return NextResponse.json(
        { error: 'number not reachable on WhatsApp' },
        { status: 422 },
      )
    }

    const r = await wahaCallsPost(coords, 'start', { to: chatId })
    if (!r.ok) {
      console.error('[waha-calls] start failed', r.status, JSON.stringify(r.data))
      return NextResponse.json(
        { error: 'start failed', data: r.data },
        { status: 502 },
      )
    }

    const callId = (r.data as { id?: string }).id ?? null

    // History row (panel "Ligações"): born 'dialing'; the modal's hangup
    // finalizes it (answered + duration, or missed) via /api/calls/waha/log.
    if (callId) {
      try {
        const digits = normalizePhone(body.to)
        const contact = digits
          ? firstOrNull(
              await db
                .select({ id: contacts.id })
                .from(contacts)
                .where(
                  and(
                    eq(contacts.accountId, ctx.accountId),
                    eq(contacts.phoneNormalized, digits),
                  ),
                )
                .limit(1),
            )
          : null
        await db
          .insert(callLogs)
          .values({
            accountId: ctx.accountId,
            channelId: body.channelId ?? null,
            contactId: contact?.id ?? null,
            peer: chatId,
            direction: 'out',
            status: 'dialing',
            provider: 'waha',
            externalCallId: callId,
          })
          .onConflictDoNothing()
      } catch (err) {
        console.error('[waha-calls] history insert failed:', err)
      }
    }

    return NextResponse.json({ ok: true, callId, chatId })
  } catch (err) {
    return toErrorResponse(err)
  }
}
