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

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const [row] = await db
      .select({
        elevenlabsApiKey: voiceSettings.elevenlabsApiKey,
        openaiApiKey: voiceSettings.openaiApiKey,
      })
      .from(voiceSettings)
      .where(eq(voiceSettings.accountId, ctx.accountId))
      .limit(1)
    return NextResponse.json({
      elevenlabsSet: !!row?.elevenlabsApiKey,
      openaiSet: !!row?.openaiApiKey,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as {
      elevenlabsApiKey?: unknown
      openaiApiKey?: unknown
    }

    // Only touch a field that was actually sent. '' clears it; a value encrypts.
    const patch: Record<string, string | null> = {}
    if (typeof body.elevenlabsApiKey === 'string') {
      const v = body.elevenlabsApiKey.trim()
      patch.elevenlabsApiKey = v ? encrypt(v) : null
    }
    if (typeof body.openaiApiKey === 'string') {
      const v = body.openaiApiKey.trim()
      patch.openaiApiKey = v ? encrypt(v) : null
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
