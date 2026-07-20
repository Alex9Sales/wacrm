// ============================================================
// Internal voice config for the media bridge (IA de voz — fatia 2).
//
//   GET /api/internal/voice-config?session=<wahaSession>
//   GET /api/internal/voice-config?channelId=<id>
//
// Given the waha session a call arrived on (or a channel id), returns that
// channel's voice-agent config PLUS the account's decrypted provider keys, so
// the bridge can answer with the right persona/voice/keys instead of local
// files. Server-to-server ONLY: gated by a bearer service token
// (VOICE_BRIDGE_TOKEN). Returns decrypted secrets — never expose publicly.
// ============================================================

import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'

import { db, channels, voiceAgents, voiceSettings } from '@/db'
import { decrypt } from '@/lib/whatsapp/encryption'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const token = process.env.VOICE_BRIDGE_TOKEN
  const auth = request.headers.get('authorization') ?? ''
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const session = url.searchParams.get('session')
  const channelId = url.searchParams.get('channelId')
  if (!session && !channelId) {
    return NextResponse.json(
      { error: 'session or channelId required' },
      { status: 400 },
    )
  }

  const [ch] = await db
    .select({
      id: channels.id,
      accountId: channels.accountId,
      name: channels.name,
      phoneNumber: channels.phoneNumber,
    })
    .from(channels)
    .where(
      channelId
        ? eq(channels.id, channelId)
        : sql`${channels.providerMeta}->>'session' = ${session}`,
    )
    .limit(1)
  if (!ch) {
    return NextResponse.json({ found: false })
  }

  const [va] = await db
    .select()
    .from(voiceAgents)
    .where(eq(voiceAgents.channelId, ch.id))
    .limit(1)
  const [vs] = await db
    .select()
    .from(voiceSettings)
    .where(eq(voiceSettings.accountId, ch.accountId))
    .limit(1)

  const dec = (v: string | null | undefined): string => {
    if (!v) return ''
    try {
      return decrypt(v)
    } catch {
      return ''
    }
  }

  return NextResponse.json({
    found: true,
    channelId: ch.id,
    channelName: ch.name,
    phoneNumber: ch.phoneNumber,
    enabled: va?.enabled ?? false,
    mode: va?.mode ?? 'overflow',
    prompt: va?.systemPrompt ?? '',
    voiceId: va?.voiceId ?? '',
    greeting: va?.greeting ?? '',
    llmProvider: vs?.llmProvider ?? 'openai',
    elevenlabsKey: dec(vs?.elevenlabsApiKey),
    openaiKey: dec(vs?.openaiApiKey),
  })
}
