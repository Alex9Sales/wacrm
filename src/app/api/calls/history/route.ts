// ============================================================
// GET /api/calls/history — o painel "Ligações" (estilo WhatsApp). Últimas
// chamadas da conta em qualquer via (waha/meta), com contato e canal
// resolvidos pra exibição e ligar de volta.
// ============================================================

import { NextResponse } from 'next/server'
import { desc, eq, sql } from 'drizzle-orm'

import { db, callLogs, channels, contacts, conversations } from '@/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    // The contact's conversation for the click-to-open shortcut — prefer the
    // conversation on the call's own channel, fall back to the most recent.
    const conversationIdSql = sql<string | null>`(
      select cv.id from conversations cv
      where cv.contact_id = ${callLogs.contactId}
        and cv.account_id = ${ctx.accountId}
      order by (cv.channel_id = ${callLogs.channelId}) desc,
        cv.last_message_at desc nulls last
      limit 1
    )`
    const rows = await db
      .select({
        id: callLogs.id,
        peer: callLogs.peer,
        direction: callLogs.direction,
        status: callLogs.status,
        provider: callLogs.provider,
        durationSec: callLogs.durationSec,
        createdAt: callLogs.createdAt,
        channelId: callLogs.channelId,
        channelName: channels.name,
        contactId: contacts.id,
        contactName: contacts.name,
        contactPhone: contacts.phone,
        conversationId: conversationIdSql,
      })
      .from(callLogs)
      .leftJoin(channels, eq(channels.id, callLogs.channelId))
      .leftJoin(contacts, eq(contacts.id, callLogs.contactId))
      .where(eq(callLogs.accountId, ctx.accountId))
      .orderBy(desc(callLogs.createdAt))
      .limit(100)
    return NextResponse.json({ calls: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}
