// ============================================================
// Voice tool — marcar_sem_venda (IA de voz — fatia 4b).
//
//   POST /api/internal/voice-tools/mark-status
//     { session? | channelId?, from, callerName?, status, motivo? }
//     status ∈ 'interessado' | 'cancelado' | 'nao_quis'
//
// When a call ends WITHOUT a sale, the AI records the outcome as a card in the
// matching Funil stage (Interessado / Cancelado / Nao Quiz), so it can be
// filtered later for reactivation. Server-to-server: bearer token.
// ============================================================

import { NextResponse } from 'next/server'

import { resolveVoiceChannel, createVoiceDeal } from '@/lib/voice/deal'

export const dynamic = 'force-dynamic'

// status → Funil stage name (matched fuzzily) + human label for the card title.
const STATUS_STAGE: Record<string, { stage: string; label: string }> = {
  interessado: { stage: 'Interessado', label: 'Interessado' },
  cancelado: { stage: 'Cancelado', label: 'Cancelado' },
  nao_quis: { stage: 'Nao Quiz', label: 'Não quis comprar' },
}

export async function POST(request: Request) {
  const token = process.env.VOICE_BRIDGE_TOKEN
  if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    session?: unknown
    channelId?: unknown
    from?: unknown
    callerName?: unknown
    status?: unknown
    motivo?: unknown
  }
  const session = typeof body.session === 'string' ? body.session : ''
  const channelId = typeof body.channelId === 'string' ? body.channelId : ''
  const from = typeof body.from === 'string' ? body.from.replace(/\D/g, '') : ''
  const callerName =
    typeof body.callerName === 'string' ? body.callerName : undefined
  const status = typeof body.status === 'string' ? body.status : ''
  const motivo = typeof body.motivo === 'string' ? body.motivo : ''

  const map = STATUS_STAGE[status]
  if (!map) {
    return NextResponse.json({ ok: false, reason: 'invalid status' })
  }

  const ch = await resolveVoiceChannel(session, channelId)
  if (!ch) return NextResponse.json({ ok: false, reason: 'channel not found' })
  if (!ch.pipelineId) {
    return NextResponse.json({ ok: false, reason: 'no pipeline configured' })
  }

  let dealId: string | null = null
  try {
    dealId = await createVoiceDeal({
      accountId: ch.accountId,
      pipelineId: ch.pipelineId,
      stageName: map.stage,
      from,
      callerName,
      title: map.label,
      notes: motivo || undefined,
    })
  } catch (err) {
    console.error('[mark-status] deal failed:', err)
    return NextResponse.json({ ok: false, reason: 'deal failed' })
  }

  return NextResponse.json({ ok: true, dealId })
}
