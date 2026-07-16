// ============================================================
// POST /api/conversations/resolve — find-or-create the conversation for a
// phone number within the current account (UI session), so the inbox can
// jump straight into it (e.g. the "Conversar" button on a shared contact
// card). Body: { phone, channelId? }. Returns { conversationId }.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as {
      phone?: string
      channelId?: string
    }
    if (!body.phone || typeof body.phone !== 'string') {
      return NextResponse.json({ error: 'phone required' }, { status: 400 })
    }
    const resolved = await resolveConversationByPhone(
      ctx.accountId,
      body.phone,
      undefined, // name
      body.channelId ?? null,
    )
    return NextResponse.json({ conversationId: resolved.conversationId })
  } catch (err) {
    return toErrorResponse(err)
  }
}
