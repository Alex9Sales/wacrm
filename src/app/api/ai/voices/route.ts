import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, voiceSettings } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/ai/voices — lista as vozes do ElevenLabs da conta, pra o seletor de
 * voz do agente. Usa a chave em voice_settings (setada em Agentes de voz).
 * Retorna { voices: { id, name }[] } ou { voices: [], error } se não configurada.
 */
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
    if (!row?.k) {
      return NextResponse.json({
        voices: [],
        error: 'Sem chave ElevenLabs. Configure em Agentes de voz.',
      })
    }
    const key = decrypt(row.k)
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
    })
    if (!res.ok) {
      return NextResponse.json({
        voices: [],
        error:
          res.status === 401
            ? 'Chave ElevenLabs inválida.'
            : `Falha ao listar vozes (HTTP ${res.status}).`,
      })
    }
    const data = (await res.json().catch(() => null)) as {
      voices?: { voice_id?: string; name?: string }[]
    } | null
    const voices = (data?.voices ?? [])
      .filter((v) => v.voice_id && v.name)
      .map((v) => ({ id: v.voice_id as string, name: v.name as string }))
    return NextResponse.json({ voices })
  } catch (err) {
    return toErrorResponse(err)
  }
}
