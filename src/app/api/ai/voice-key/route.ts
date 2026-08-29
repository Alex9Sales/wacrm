// ============================================================
// Chave ElevenLabs pro ÁUDIO DA IA (nota de voz no WhatsApp). Feature liberada
// — separada do beta do agente de VOZ/ligações. Guarda em voice_settings
// (mesma coluna, compartilhada), AES-GCM. Admin-gated.
//   GET → { elevenlabsSet }         PUT { elevenlabsApiKey } → valida + salva.
// ============================================================

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, voiceSettings } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const row = firstOrNull(
      await db
        .select({ k: voiceSettings.elevenlabsApiKey })
        .from(voiceSettings)
        .where(eq(voiceSettings.accountId, ctx.accountId))
        .limit(1),
    )
    return NextResponse.json({ elevenlabsSet: !!row?.k })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as {
      elevenlabsApiKey?: unknown
    }
    const raw =
      typeof body.elevenlabsApiKey === 'string' ? body.elevenlabsApiKey.trim() : ''

    // '' limpa a chave (volta pra voz da OpenAI).
    if (!raw) {
      await db
        .insert(voiceSettings)
        .values({
          accountId: ctx.accountId,
          elevenlabsApiKey: null,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: voiceSettings.accountId,
          set: { elevenlabsApiKey: null, updatedAt: new Date().toISOString() },
        })
      return NextResponse.json({ ok: true, voices: [] })
    }

    // Valida a chave contra o ElevenLabs (e já traz as vozes).
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': raw },
    })
    if (!res.ok) {
      return NextResponse.json(
        {
          error:
            res.status === 401
              ? 'Chave ElevenLabs inválida.'
              : `Não foi possível validar a chave (HTTP ${res.status}).`,
        },
        { status: 400 },
      )
    }
    const data = (await res.json().catch(() => null)) as {
      voices?: { voice_id?: string; name?: string }[]
    } | null
    const voices = (data?.voices ?? [])
      .filter((v) => v.voice_id && v.name)
      .map((v) => ({ id: v.voice_id as string, name: v.name as string }))

    const now = new Date().toISOString()
    await db
      .insert(voiceSettings)
      .values({ accountId: ctx.accountId, elevenlabsApiKey: encrypt(raw), updatedAt: now })
      .onConflictDoUpdate({
        target: voiceSettings.accountId,
        set: { elevenlabsApiKey: encrypt(raw), updatedAt: now },
      })
    return NextResponse.json({ ok: true, voices })
  } catch (err) {
    return toErrorResponse(err)
  }
}
