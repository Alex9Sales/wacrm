// ============================================================
// 🧾 Fase 4 — parar de cobrar quem pagou (o que o webhook do Asaas dispara).
//
// Primeira das duas travas. A segunda — reconsultar imediatamente antes de
// cada envio — já está no executor desde a Fase 2 e continua valendo se este
// webhook falhar, atrasar ou se perder. Uma trava só não basta para um erro
// que não tem desfazer.
//
// Sem 'server-only' — a rota e o worker alcançam isso.
// ============================================================

import { and, eq, inArray, sql } from 'drizzle-orm'

import { db, agentActionRequests, asaasCharges, asaasConnections, collectionsTouches } from '@/db'
import { firstOrNull } from '@/db/helpers'

/** Eventos do Asaas que significam "não deve mais". */
const SETTLED_EVENTS = new Set([
  'PAYMENT_RECEIVED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED_IN_CASH',
  'PAYMENT_APPROVED_BY_RISK_ANALYSIS',
])

/** Eventos em que a cobrança deixa de existir (some da carteira). */
const GONE_EVENTS = new Set(['PAYMENT_DELETED', 'PAYMENT_RESTORED_FROM_DELETION_REVERSED'])

/** Voltou a dever: estorno, chargeback, ou o pagamento foi desfeito. */
const REOPENED_EVENTS = new Set([
  'PAYMENT_OVERDUE',
  'PAYMENT_REFUNDED',
  'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
])

export interface AsaasWebhookBody {
  event?: string
  payment?: { id?: string; status?: string; customer?: string }
}

export interface WebhookOutcome {
  /** Sempre 200 para o Asaas, exceto token inválido — evento repetido é normal. */
  handled: boolean
  /** O que foi feito, para o log. */
  action: 'settled' | 'reopened' | 'gone' | 'ignored' | 'unknown_charge'
  /** Toques pendentes que foram cancelados por causa disso. */
  cancelledRequests: number
}

/**
 * Aplica um evento do Asaas. Idempotente de propósito: o Asaas reenvia o mesmo
 * evento quando não recebe 200, e reprocessar não pode causar efeito duplo.
 */
export async function applyAsaasEvent(connectionId: string, accountId: string, body: AsaasWebhookBody): Promise<WebhookOutcome> {
  const event = (body.event ?? '').toUpperCase()
  const paymentId = body.payment?.id

  await db
    .update(asaasConnections)
    .set({ webhookLastAt: new Date().toISOString(), webhookEvents: sql`${asaasConnections.webhookEvents} + 1` })
    .where(eq(asaasConnections.id, connectionId))

  if (!paymentId) return { handled: true, action: 'ignored', cancelledRequests: 0 }

  const charge = firstOrNull(
    await db
      .select({ id: asaasCharges.id, contactId: asaasCharges.contactId, open: asaasCharges.open })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.asaasId, paymentId)))
      .limit(1),
  )

  const settled = SETTLED_EVENTS.has(event)
  const gone = GONE_EVENTS.has(event)
  const reopened = REOPENED_EVENTS.has(event)
  if (!settled && !gone && !reopened) return { handled: true, action: 'ignored', cancelledRequests: 0 }

  // Cobrança que a gente nunca espelhou (a régua só puxa as vencidas). Pagamento
  // de algo que nunca cobramos não exige nada — mas se ela VENCEU agora, a
  // próxima sincronização traz.
  if (!charge) return { handled: true, action: 'unknown_charge', cancelledRequests: 0 }

  const now = new Date().toISOString()

  if (reopened) {
    // Voltou a dever: a cobrança volta para a carteira e a próxima rodada da
    // régua decide o que fazer. Não cobramos aqui, de dentro de um webhook.
    await db
      .update(asaasCharges)
      .set({ open: true, closedAt: null, status: body.payment?.status ?? 'OVERDUE', updatedAt: now })
      .where(eq(asaasCharges.id, charge.id))
    return { handled: true, action: 'reopened', cancelledRequests: 0 }
  }

  await db
    .update(asaasCharges)
    .set({ open: false, closedAt: now, status: body.payment?.status ?? (gone ? 'DELETED' : 'RECEIVED'), updatedAt: now })
    .where(eq(asaasCharges.id, charge.id))

  if (!charge.contactId) return { handled: true, action: settled ? 'settled' : 'gone', cancelledRequests: 0 }

  // 🛑 O ponto da fase: cancelar o que ainda não saiu. Só cancelamos quando o
  // devedor não tem MAIS NADA em aberto — quem paga uma de três parcelas
  // continua devendo duas, e a cobrança dessas duas segue de pé.
  const aindaDeve = firstOrNull(
    await db
      .select({ id: asaasCharges.id })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, charge.contactId), eq(asaasCharges.open, true)))
      .limit(1),
  )
  if (aindaDeve) return { handled: true, action: settled ? 'settled' : 'gone', cancelledRequests: 0 }

  const cancelled = await db
    .update(agentActionRequests)
    .set({
      status: 'expired',
      resolvedAt: now,
      policy: settled ? 'Cancelada: o cliente pagou antes do envio.' : 'Cancelada: a cobrança deixou de existir no Asaas.',
    })
    .where(
      and(
        eq(agentActionRequests.accountId, accountId),
        eq(agentActionRequests.contactId, charge.contactId),
        eq(agentActionRequests.actionType, 'collect_charges'),
        inArray(agentActionRequests.status, ['pending']),
      ),
    )
    .returning({ id: agentActionRequests.id })

  // Zera o estado da régua: se ele voltar a dever amanhã, começa do primeiro
  // toque, com o tom de lembrete — e não do sétimo, como se nada tivesse mudado.
  await db
    .update(collectionsTouches)
    .set({ touchCount: 0, snoozeUntil: null, snoozeReason: null, updatedAt: now })
    .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, charge.contactId)))

  return { handled: true, action: settled ? 'settled' : 'gone', cancelledRequests: cancelled.length }
}

/** Acha a conexão pelo token da URL. Token inválido = 404, sem detalhe. */
export async function connectionByWebhookToken(token: string) {
  if (!token || token.length < 20) return null
  return firstOrNull(
    await db
      .select({ id: asaasConnections.id, accountId: asaasConnections.accountId, label: asaasConnections.label })
      .from(asaasConnections)
      .where(eq(asaasConnections.webhookToken, token))
      .limit(1),
  )
}
