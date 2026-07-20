// ============================================================
// Voice tool — notificar_pedido (IA de voz — fatia 4).
//
//   POST /api/internal/voice-tools/notify-order
//     { session? | channelId?, order: { cliente, telefone, endereco,
//       referencia?, produto, valor, pagamento, troco?, obs? } }
//
// The voice AI calls this when it closes an order. The CRM formats the order
// summary (same layout the n8n flow used) and sends it on WhatsApp to the
// channel's configured notify_phone (the dispatcher / "celular do gás").
// Server-to-server: gated by the bearer service token.
// ============================================================

import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'

import { db, channels, voiceAgents } from '@/db'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'

export const dynamic = 'force-dynamic'

interface Order {
  cliente?: string
  telefone?: string
  endereco?: string
  referencia?: string
  produto?: string
  valor?: string
  pagamento?: string
  troco?: string
  obs?: string
}

function formatOrder(o: Order, businessName: string): string {
  const L: string[] = []
  L.push(`🚚 *NOVO PEDIDO — ${businessName.toUpperCase()}*`)
  L.push('')
  if (o.cliente) L.push(`👤 *Cliente:* ${o.cliente}`)
  if (o.telefone) L.push(`📱 *Telefone:* ${o.telefone}`)
  if (o.endereco) {
    L.push(
      `📍 *Endereço:* ${o.endereco}${o.referencia ? `. Referência: ${o.referencia}` : ''}`,
    )
  }
  if (o.produto) L.push(`📦 *Produto:* ${o.produto}`)
  if (o.valor) L.push(`💰 *Valor:* ${o.valor}`)
  if (o.pagamento) {
    L.push(
      `💳 *Pagamento:* ${o.pagamento}${o.troco ? ` (troco para ${o.troco})` : ''}`,
    )
  }
  L.push(`📝 *Obs:* ${o.obs && o.obs.trim() ? o.obs : 'Sem observações adicionais.'}`)
  L.push('')
  L.push('⚡ Despachar entregador disponível!')
  return L.join('\n')
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
    order?: unknown
  }
  const session = typeof body.session === 'string' ? body.session : ''
  const channelId = typeof body.channelId === 'string' ? body.channelId : ''
  const order = (body.order && typeof body.order === 'object'
    ? body.order
    : {}) as Order

  const [ch] = await db
    .select({ id: channels.id, name: channels.name })
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

  const [va] = await db
    .select({ notifyPhone: voiceAgents.notifyPhone })
    .from(voiceAgents)
    .where(eq(voiceAgents.channelId, ch.id))
    .limit(1)
  const notifyPhone = va?.notifyPhone?.replace(/\D/g, '') ?? ''
  if (!notifyPhone) {
    return NextResponse.json({
      ok: false,
      reason: 'no notify_phone configured for this channel',
    })
  }

  const text = formatOrder(order, ch.name)

  try {
    const channel = await loadChannel(ch.id)
    if (!channel) {
      return NextResponse.json({ ok: false, reason: 'channel load failed' })
    }
    const provider = getProvider(channel.provider)
    await provider.sendText(channel, notifyPhone, text)
  } catch (err) {
    console.error('[notify-order] send failed:', err)
    return NextResponse.json({ ok: false, reason: 'send failed' })
  }

  return NextResponse.json({ ok: true, notified: notifyPhone })
}
