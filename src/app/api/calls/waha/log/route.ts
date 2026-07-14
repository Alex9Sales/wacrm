// ============================================================
// POST /api/calls/waha/log — record a finished OUTBOUND waha-voip call as a
// call-log entry in the conversation (WhatsApp-style), mirroring the Meta
// webhook's terminate log. Body: { conversationId, durationSec, answered }.
//
// waha-voip does NOT emit a "call terminated" webhook (only received/accepted/
// rejected), so the browser reports the outcome on hang-up. Scoped to the
// caller's account.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, callLogs, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { buildCallLog } from '@/lib/inbox/call-log'
import { publishEvent } from '@/lib/events/publish'

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as {
      conversationId?: string
      durationSec?: number
      answered?: boolean
      callId?: string
    }
    // Finalize the history row regardless of a conversation (the panel is
    // the source of truth; the chat entry below needs the conversation).
    if (body.callId) {
      try {
        await db
          .update(callLogs)
          .set({
            status: body.answered ? 'answered' : 'missed',
            durationSec: body.answered
              ? Math.max(0, Math.round(body.durationSec ?? 0))
              : null,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(callLogs.accountId, ctx.accountId),
              eq(callLogs.externalCallId, body.callId),
            ),
          )
      } catch (err) {
        console.error('[waha-calls] history finalize failed:', err)
      }
    }
    if (!body.conversationId) {
      return NextResponse.json({ ok: true, chatLog: false })
    }

    const conv = firstOrNull(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, body.conversationId),
            eq(conversations.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!conv) {
      return NextResponse.json(
        { error: 'conversation not found' },
        { status: 404 },
      )
    }

    await db.insert(messages).values({
      conversationId: conv.id,
      senderType: 'agent', // outbound — shows on the agent's side
      contentType: 'text',
      contentText: buildCallLog({
        answered: !!body.answered,
        durationSec: body.durationSec,
      }),
    })
    // Refresh the thread without ringing (fromMe skips the notification sound).
    await publishEvent(ctx.accountId, {
      type: 'message.received',
      conversationId: conv.id,
      fromMe: true,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
