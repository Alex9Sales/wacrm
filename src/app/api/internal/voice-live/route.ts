// ============================================================
// Live voice-call monitor sink (IA de voz — fatia 5, parte A).
//
//   POST /api/internal/voice-live
//     { session? | channelId?, callId, phase: 'start'|'line'|'end',
//       from?, callerName?, role?: 'ai'|'customer', text? }
//
// The media bridge streams each spoken line AS IT HAPPENS; we fan it out on the
// account's SSE stream (type 'voice_live') so an operator can watch the AI call
// unfold in real time on the Supervisão page. Server-to-server: bearer token.
// ============================================================

import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'

import { db, channels } from '@/db'
import { publishEvent } from '@/lib/events/publish'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const token = process.env.VOICE_BRIDGE_TOKEN
  if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    session?: unknown
    channelId?: unknown
    callId?: unknown
    phase?: unknown
    from?: unknown
    callerName?: unknown
    role?: unknown
    text?: unknown
  }
  const session = typeof body.session === 'string' ? body.session : ''
  const channelId = typeof body.channelId === 'string' ? body.channelId : ''
  const callId = typeof body.callId === 'string' ? body.callId : ''
  const phase =
    body.phase === 'start' || body.phase === 'line' || body.phase === 'end'
      ? body.phase
      : null
  if (!callId || !phase) {
    return NextResponse.json({ ok: false, reason: 'callId/phase required' })
  }

  const [ch] = await db
    .select({ accountId: channels.accountId, name: channels.name })
    .from(channels)
    .where(
      channelId
        ? eq(channels.id, channelId)
        : sql`${channels.providerMeta}->>'session' = ${session}`,
    )
    .limit(1)
  if (!ch) return NextResponse.json({ ok: false, reason: 'channel not found' })

  await publishEvent(ch.accountId, {
    type: 'voice_live',
    callId,
    phase,
    channelName: ch.name,
    from: typeof body.from === 'string' ? body.from : undefined,
    callerName: typeof body.callerName === 'string' ? body.callerName : undefined,
    role: body.role === 'ai' || body.role === 'customer' ? body.role : undefined,
    text: typeof body.text === 'string' ? body.text : undefined,
  })
  return NextResponse.json({ ok: true })
}
