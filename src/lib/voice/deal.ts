// ============================================================
// Shared helpers for the voice tools that drop cards into a Funil (IA de voz —
// fatia 4b). Resolve the channel's voice config, the caller's contact, and
// create a deal in a named stage. Used by the register-order / mark-status
// internal endpoints.
// ============================================================

import { and, eq, ilike, sql } from 'drizzle-orm'

import {
  db,
  channels,
  deals,
  pipelineStages,
  voiceAgents,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

export interface VoiceChannel {
  id: string
  accountId: string
  name: string
  pipelineId: string | null
  notifyPhone: string | null
}

/** Resolve a channel + its voice-agent config by waha session or channel id. */
export async function resolveVoiceChannel(
  session: string,
  channelId: string,
): Promise<VoiceChannel | null> {
  const [row] = await db
    .select({
      id: channels.id,
      accountId: channels.accountId,
      name: channels.name,
      pipelineId: voiceAgents.pipelineId,
      notifyPhone: voiceAgents.notifyPhone,
    })
    .from(channels)
    .leftJoin(voiceAgents, eq(voiceAgents.channelId, channels.id))
    .where(
      channelId
        ? eq(channels.id, channelId)
        : sql`${channels.providerMeta}->>'session' = ${session}`,
    )
    .limit(1)
  return row ?? null
}

/** Find a stage id in a pipeline by name (case/accents-insensitive-ish).
 *  Falls back to the first stage (position 0) when no name matches. */
export async function resolveStageId(
  pipelineId: string,
  stageName: string,
): Promise<string | null> {
  if (stageName) {
    const [hit] = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.pipelineId, pipelineId),
          ilike(pipelineStages.name, `%${stageName}%`),
        ),
      )
      .limit(1)
    if (hit) return hit.id
  }
  const [first] = await db
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipelineId))
    .orderBy(pipelineStages.position)
    .limit(1)
  return first?.id ?? null
}

export interface Order {
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

/** The dispatch message the "celular do gás" receives (same layout as n8n). */
export function formatOrder(o: Order, businessName: string): string {
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

/** A compact one-line order summary for the deal card notes/title. */
export function orderSummary(o: Order): string {
  return [o.produto, o.endereco, o.pagamento, o.valor]
    .filter(Boolean)
    .join(' · ')
}

/** "R$ 125,00" / "125,00" / "125" → 125.00 (number as string for numeric col). */
export function parseBRL(v: string | undefined): string {
  if (!v) return '0'
  const cleaned = String(v).replace(/[^\d,.]/g, '')
  // 1.234,56 → 1234.56 ; 125,00 → 125.00 ; 125 → 125
  const norm = cleaned.includes(',')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned
  const n = Number(norm)
  return Number.isFinite(n) ? String(n) : '0'
}

/** Create a deal (card) in a channel's pipeline at the given stage name, for the
 *  caller's contact. Returns the deal id (or null on failure). Best-effort. */
export async function createVoiceDeal(opts: {
  accountId: string
  pipelineId: string
  stageName: string
  from: string
  callerName?: string | null
  title: string
  value?: string
  notes?: string
  /** The CALL's channel. Passing it keeps the deal's conversation on the SAME
   *  channel as the call (e.g. waha) — resolving on the same channel returns the
   *  EXISTING conversation instead of creating a duplicate. Without it (null),
   *  resolveConversationByPhone falls back to loadDefaultChannel (Meta) and
   *  spawns an empty ghost conversation on the wrong channel. */
  channelId?: string | null
}): Promise<string | null> {
  const stageId = await resolveStageId(opts.pipelineId, opts.stageName)
  if (!stageId) return null

  let contactId: string | null = null
  let conversationId: string | null = null
  try {
    const resolved = await resolveConversationByPhone(
      opts.accountId,
      opts.from,
      opts.callerName ?? null,
      opts.channelId ?? null,
    )
    contactId = resolved.contactId
    conversationId = resolved.conversationId
  } catch {
    // no valid phone → deal without a contact (still useful on the board)
  }

  const userId = await resolveAuditUserId(opts.accountId)
  const inserted = firstOrNull(
    await db
      .insert(deals)
      .values({
        userId,
        accountId: opts.accountId,
        pipelineId: opts.pipelineId,
        stageId,
        contactId,
        conversationId,
        title: opts.title,
        value: parseBRL(opts.value),
        currency: 'BRL',
        notes: opts.notes ?? null,
      })
      .returning({ id: deals.id }),
  )
  return inserted?.id ?? null
}
