// ============================================================
// GET /api/calls/history — o painel "Ligações" (estilo WhatsApp). Últimas
// chamadas da conta em qualquer via (waha/meta), com contato e canal
// resolvidos pra exibição e ligar de volta.
// ============================================================

import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'

import { db, callLogs, channels, contacts } from '@/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
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
