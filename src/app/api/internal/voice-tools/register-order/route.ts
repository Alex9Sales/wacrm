// ============================================================
// Voice tool — registrar_pedido (IA de voz — fatia 4b).
//
//   POST /api/internal/voice-tools/register-order
//     { session? | channelId?, from, callerName?, order: {...} }
//
// When the voice AI closes a sale it calls this. The CRM (1) creates a card in
// the channel's Funil at "Novo Pedido" and (2) sends the dispatch summary on
// WhatsApp to the channel's notify_phone. Server-to-server: bearer token.
// ============================================================

import { NextResponse } from 'next/server'

import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import {
  resolveVoiceChannel,
  createVoiceDeal,
  formatOrder,
  orderSummary,
  type Order,
} from '@/lib/voice/deal'

export const dynamic = 'force-dynamic'

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
    order?: unknown
  }
  const session = typeof body.session === 'string' ? body.session : ''
  const channelId = typeof body.channelId === 'string' ? body.channelId : ''
  const from = typeof body.from === 'string' ? body.from.replace(/\D/g, '') : ''
  const callerName =
    typeof body.callerName === 'string' ? body.callerName : undefined
  const order = (body.order && typeof body.order === 'object'
    ? body.order
    : {}) as Order

  const ch = await resolveVoiceChannel(session, channelId)
  if (!ch) return NextResponse.json({ ok: false, reason: 'channel not found' })

  // 1) Create the deal in the Funil ("Novo Pedido").
  let dealId: string | null = null
  if (ch.pipelineId) {
    try {
      dealId = await createVoiceDeal({
        accountId: ch.accountId,
        pipelineId: ch.pipelineId,
        stageName: 'Novo Pedido',
        from: from || order.telefone?.replace(/\D/g, '') || '',
        callerName: order.cliente ?? callerName ?? null,
        title: `Pedido — ${order.produto || 'gás'}`,
        value: order.valor,
        notes: orderSummary(order),
      })
    } catch (err) {
      console.error('[register-order] deal failed:', err)
    }
  }

  // 2) Dispatch summary on WhatsApp to the notify_phone.
  let notified = false
  const notifyPhone = ch.notifyPhone?.replace(/\D/g, '') ?? ''
  if (notifyPhone) {
    try {
      const channel = await loadChannel(ch.id)
      if (channel) {
        const provider = getProvider(channel.provider)
        await provider.sendText(channel, notifyPhone, formatOrder(order, ch.name))
        notified = true
      }
    } catch (err) {
      console.error('[register-order] notify failed:', err)
    }
  }

  return NextResponse.json({ ok: true, dealId, notified })
}
