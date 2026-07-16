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
import { and, eq, inArray } from 'drizzle-orm'

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
    // Finalize the history row (the panel is the source of truth). Promote-
    // only: never downgrade a call the call.accepted webhook already marked
    // answered (e.g. the peer hung up first and the modal missed the state).
    let historyRow: {
      contactId: string | null
      channelId: string | null
    } | null = null
    if (body.callId) {
      try {
        const now = new Date().toISOString()
        await db
          .update(callLogs)
          .set({
            status: body.answered ? 'answered' : 'missed',
            durationSec: body.answered
              ? Math.max(0, Math.round(body.durationSec ?? 0))
              : null,
            // The leg is over — stamp it. Without this the row stays open and
            // the "channel busy" check (answered AND ended_at IS NULL) reads
            // this finished call as still running, auto-rejecting real
            // customers on that number for the next 30 minutes. gows fires no
            // webhook when WE end the call, so this is the only thing that
            // closes an agent-hung-up row.
            endedAt: now,
            updatedAt: now,
          })
          .where(
            body.answered
              ? and(
                  eq(callLogs.accountId, ctx.accountId),
                  eq(callLogs.externalCallId, body.callId),
                )
              : and(
                  eq(callLogs.accountId, ctx.accountId),
                  eq(callLogs.externalCallId, body.callId),
                  inArray(callLogs.status, ['dialing', 'missed']),
                ),
          )
        historyRow = firstOrNull(
          await db
            .select({
              contactId: callLogs.contactId,
              channelId: callLogs.channelId,
            })
            .from(callLogs)
            .where(
              and(
                eq(callLogs.accountId, ctx.accountId),
                eq(callLogs.externalCallId, body.callId),
              ),
            )
            .limit(1),
        )
      } catch (err) {
        console.error('[waha-calls] history finalize failed:', err)
      }
    }

    // Chat entry (WhatsApp-style: the call shows in the thread and bumps the
    // conversation to the top). Prefer the conversation the modal was opened
    // from; otherwise resolve it from the call's contact + channel (calls
    // placed from the Ligações panel don't carry a conversationId).
    let conv: { id: string } | null = null
    if (body.conversationId) {
      conv = firstOrNull(
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
    } else if (historyRow?.contactId && historyRow.channelId) {
      conv = firstOrNull(
        await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.accountId, ctx.accountId),
              eq(conversations.contactId, historyRow.contactId),
              eq(conversations.channelId, historyRow.channelId),
            ),
          )
          .limit(1),
      )
    }
    if (!conv) {
      return NextResponse.json({ ok: true, chatLog: false })
    }

    const logText = buildCallLog({
      answered: !!body.answered,
      durationSec: body.durationSec,
    })
    await db.insert(messages).values({
      conversationId: conv.id,
      senderType: 'agent', // outbound — shows on the agent's side
      contentType: 'text',
      contentText: logText,
    })
    // Direct inserts bypass the inbound pipeline, so bump the conversation
    // preview/ordering ourselves (WhatsApp-style: the call floats the chat
    // to the top of the list).
    await db
      .update(conversations)
      .set({
        lastMessageText: logText,
        lastMessageAt: new Date().toISOString(),
      })
      .where(eq(conversations.id, conv.id))
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
