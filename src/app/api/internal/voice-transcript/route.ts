// ============================================================
// Internal voice transcript sink (IA de voz — fatia 3).
//
//   POST /api/internal/voice-transcript
//     { session? | channelId?, from, callerName?, callId, durationSec?,
//       lines: [{ role: 'ai'|'customer', text }] }
//
// The media bridge posts the finished call's transcript here; we resolve the
// caller's conversation (by phone on the call's channel) and drop ONE readable
// message with the whole dialogue, so an operator can read what the AI and the
// customer said. Server-to-server: gated by the same bearer service token.
// ============================================================

import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'

import { db, channels, conversations, messages } from '@/db'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { publishEvent } from '@/lib/events/publish'

export const dynamic = 'force-dynamic'

interface Line {
  role: 'ai' | 'customer'
  text: string
}

export async function POST(request: Request) {
  const token = process.env.VOICE_BRIDGE_TOKEN
  const auth = request.headers.get('authorization') ?? ''
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    session?: unknown
    channelId?: unknown
    from?: unknown
    callerName?: unknown
    durationSec?: unknown
    lines?: unknown
  }
  const session = typeof body.session === 'string' ? body.session : ''
  const channelId = typeof body.channelId === 'string' ? body.channelId : ''
  const from = typeof body.from === 'string' ? body.from.replace(/\D/g, '') : ''
  const callerName =
    typeof body.callerName === 'string' ? body.callerName : undefined
  const durationSec =
    typeof body.durationSec === 'number' ? body.durationSec : undefined
  const lines = Array.isArray(body.lines)
    ? (body.lines as Line[]).filter(
        (l) => l && typeof l.text === 'string' && l.text.trim(),
      )
    : []

  if (!from || lines.length === 0) {
    return NextResponse.json({ ok: false, reason: 'no phone or lines' })
  }

  // Resolve the channel (explicit id wins; else by the call's waha session).
  const [ch] = await db
    .select({ id: channels.id, accountId: channels.accountId })
    .from(channels)
    .where(
      channelId
        ? eq(channels.id, channelId)
        : sql`${channels.providerMeta}->>'session' = ${session}`,
    )
    .limit(1)
  if (!ch) {
    return NextResponse.json({ ok: false, reason: 'channel not found' })
  }

  let conversationId: string
  let contactId: string
  try {
    const resolved = await resolveConversationByPhone(
      ch.accountId,
      from,
      callerName ?? null,
      ch.id,
    )
    conversationId = resolved.conversationId
    contactId = resolved.contactId
  } catch (err) {
    console.error('[voice-transcript] resolve failed:', err)
    return NextResponse.json({ ok: false, reason: 'resolve failed' })
  }

  // One readable transcript message. Roles labelled; the AI side as 'bot'.
  const header = durationSec
    ? `📞 Transcrição da ligação (IA · ${Math.floor(durationSec / 60)}m${String(
        durationSec % 60,
      ).padStart(2, '0')}s)`
    : '📞 Transcrição da ligação (IA)'
  const dialogue = lines
    .map((l) => `${l.role === 'ai' ? '🤖' : '🗣️'} ${l.text.trim()}`)
    .join('\n')
  const contentText = `${header}\n\n${dialogue}`

  try {
    await db.insert(messages).values({
      conversationId,
      senderType: 'bot',
      contentType: 'text',
      contentText,
      status: 'delivered',
      createdAt: new Date().toISOString(),
    })
    await db
      .update(conversations)
      .set({
        lastMessageText: '📞 Transcrição da ligação (IA)',
        lastMessageAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(conversations.id, conversationId))
  } catch (err) {
    console.error('[voice-transcript] insert failed:', err)
    return NextResponse.json({ ok: false, reason: 'insert failed' })
  }

  await publishEvent(ch.accountId, {
    type: 'message.received',
    conversationId,
    fromMe: true,
  })

  return NextResponse.json({ ok: true, conversationId, contactId })
}
