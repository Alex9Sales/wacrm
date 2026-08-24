// ============================================================
// Voice provider credentials per account (IA de voz — chaves do cliente).
//
//   GET  /api/voice-agents/credentials  — whether each key is set (NEVER the
//                                          raw value), for the config UI.
//   PUT  /api/voice-agents/credentials  — set/replace keys
//                                          { elevenlabsApiKey?, openaiApiKey? }.
//                                          An empty string clears a key; an
//                                          absent field leaves it unchanged.
//
// Keys are stored AES-256-GCM encrypted (same scheme as ai_configs.api_key) and
// are only ever read server-side by the voice bridge. Admin-gated.
// ============================================================

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, voiceSettings } from '@/db'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'

// Voice brain engines. Only 'openai' (Realtime) is wired to the media bridge
// today; the rest are surfaced in the UI as "em breve" so the config is
// future-proof (a swap to Anthropic / self-hosted Hermes needs no schema change).
const LLM_PROVIDERS = new Set(['openai'])

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const [row] = await db
      .select({
        elevenlabsApiKey: voiceSettings.elevenlabsApiKey,
        openaiApiKey: voiceSettings.openaiApiKey,
        llmProvider: voiceSettings.llmProvider,
      })
      .from(voiceSettings)
      .where(eq(voiceSettings.accountId, ctx.accountId))
      .limit(1)
    return NextResponse.json({
      elevenlabsSet: !!row?.elevenlabsApiKey,
      llmKeySet: !!row?.openaiApiKey,
      llmProvider: row?.llmProvider ?? 'openai',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// 🎙️ Em fase final de testes — espelho do bloqueio em /api/voice-agents.
const VOICE_AGENTS_RELEASED = false

export async function PUT(request: Request) {
  try {
    if (!VOICE_AGENTS_RELEASED) {
      return NextResponse.json(
        { error: 'O agente de voz está em fase final de testes — em breve no plano Enterprise.' },
        { status: 403 },
      )
    }
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as {
      elevenlabsApiKey?: unknown
      llmApiKey?: unknown
      llmProvider?: unknown
    }

    // Only touch a field that was actually sent. '' clears it; a value encrypts.
    const patch: Record<string, string | null> = {}
    if (typeof body.elevenlabsApiKey === 'string') {
      const v = body.elevenlabsApiKey.trim()
      patch.elevenlabsApiKey = v ? encrypt(v) : null
    }
    if (typeof body.llmApiKey === 'string') {
      const v = body.llmApiKey.trim()
      patch.openaiApiKey = v ? encrypt(v) : null
    }
    if (typeof body.llmProvider === 'string' && LLM_PROVIDERS.has(body.llmProvider)) {
      patch.llmProvider = body.llmProvider
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
    }

    const now = new Date().toISOString()
    await db
      .insert(voiceSettings)
      .values({ accountId: ctx.accountId, ...patch, updatedAt: now })
      .onConflictDoUpdate({
        target: voiceSettings.accountId,
        set: { ...patch, updatedAt: now },
      })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
