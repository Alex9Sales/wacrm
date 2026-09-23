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

import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'

import { db, agentActionRequests, asaasCharges, asaasConnections, asaasCustomerLinks, collectionsTouches } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { countOpenPaymentsForCustomer, type AsaasEnv } from '@/lib/asaas/collections'
import { decrypt } from '@/lib/whatsapp/encryption'

import { settlePauseAfterPayment } from './pause'
import type { PauseAfterSettle } from './pause-rules'

/** Status do Asaas de cobrança já paga — o 2º aviso de pagamento não age de novo. */
const PAID_STATUSES = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])

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
  /** Cobrança espelhada (quando existe) — para quem chama agradecer/registrar. */
  chargeId?: string
  contactId?: string | null
  /** true = a cobrança ESTAVA aberta e fechou agora (evento repetido não conta). */
  transitioned?: boolean
  /** O que aconteceu com a pausa da régua (só em pagamento). */
  pause?: PauseAfterSettle
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
      .select({ id: asaasCharges.id, contactId: asaasCharges.contactId, open: asaasCharges.open, status: asaasCharges.status })
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
  // próxima sincronização traz. Exceção: parcela de acordo paga EM DIA nunca
  // entra na carteira, e é o pagamento dela que quita o acordo — a pausa da
  // IA que ficou por "ainda tem parcela" precisa ser conferida aqui.
  if (!charge) {
    const pause = settled ? await settleUnmirroredPayment(accountId, connectionId, body.payment?.customer ?? null) : 'none'
    return { handled: true, action: 'unknown_charge', cancelledRequests: 0, ...(pause !== 'none' ? { pause } : {}) }
  }

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

  // 🛑 O ponto da fase: cancelar o que ainda não saiu. Só cancelamos quando o
  // devedor não tem MAIS NADA em aberto — quem paga uma de três parcelas
  // continua devendo duas, e a cobrança dessas duas segue de pé. (Fora esta,
  // que fecha logo abaixo.)
  const aindaDeve = charge.contactId
    ? firstOrNull(
        await db
          .select({ id: asaasCharges.id })
          .from(asaasCharges)
          .where(
            and(
              eq(asaasCharges.accountId, accountId),
              eq(asaasCharges.contactId, charge.contactId),
              eq(asaasCharges.open, true),
              ne(asaasCharges.id, charge.id),
            ),
          )
          .limit(1),
      )
    : null

  // 🧾 Pausa que a IA pôs (acordo/contestação) sai quando ele quita — senão fica
  // valendo para sempre e invisível (Reboque Modelo, 16/09). A da equipe fica,
  // com nota. Decidida ANTES de gravar o status pago: se o webhook der erro
  // depois disto, o reenvio do Asaas ainda é o "1º pagamento" e decide de novo
  // (tirar a pausa é idempotente — o UPDATE só pega pausa que ainda existe).
  const pause =
    settled && charge.contactId && !aindaDeve
      ? await settlePauseAfterPayment({
          accountId,
          contactId: charge.contactId,
          firstSettle: !PAID_STATUSES.has(String(charge.status ?? '').toUpperCase()),
          stillOwes: false,
          nowIso: now,
          countOpenInAsaas: () => openPaymentsInAsaas(accountId, charge.contactId!, connectionId, body.payment?.customer ?? null),
        })
      : 'none'

  await db
    .update(asaasCharges)
    .set({ open: false, closedAt: now, status: body.payment?.status ?? (gone ? 'DELETED' : 'RECEIVED'), updatedAt: now })
    .where(eq(asaasCharges.id, charge.id))

  const ref = { chargeId: charge.id, contactId: charge.contactId, transitioned: charge.open === true }
  if (!charge.contactId) return { handled: true, action: settled ? 'settled' : 'gone', cancelledRequests: 0, ...ref }
  if (aindaDeve) return { handled: true, action: settled ? 'settled' : 'gone', cancelledRequests: 0, pause, ...ref }

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

  return { handled: true, action: settled ? 'settled' : 'gone', cancelledRequests: cancelled.length, pause, ...ref }
}

/**
 * Pagamento de cobrança fora da carteira: se o cadastro do Asaas é de UM
 * contato só, sem nada vencido na carteira, confere a pausa da IA. Sem nota
 * quando ela fica (cada parcela e cada reenvio repetiriam); tirar é idempotente.
 */
async function settleUnmirroredPayment(accountId: string, connectionId: string, customerId: string | null): Promise<PauseAfterSettle> {
  if (!customerId) return 'none'
  const owners = await db
    .selectDistinct({ contactId: asaasCharges.contactId })
    .from(asaasCharges)
    .where(
      and(
        eq(asaasCharges.accountId, accountId),
        eq(asaasCharges.connectionId, connectionId),
        eq(asaasCharges.asaasCustomerId, customerId),
        isNotNull(asaasCharges.contactId),
      ),
    )
    .limit(2)
  // 🔗 23/09: o dono também pode ter sido ligado À MÃO na carteira ("vincular
  // ao contato"), sem nenhuma cobrança espelhada ainda — aí `asaas_charges`
  // não sabe de nada e a pausa da IA ficava para sempre.
  const manuais = await db
    .selectDistinct({ contactId: asaasCustomerLinks.contactId })
    .from(asaasCustomerLinks)
    .where(
      and(
        eq(asaasCustomerLinks.accountId, accountId),
        eq(asaasCustomerLinks.connectionId, connectionId),
        eq(asaasCustomerLinks.asaasCustomerId, customerId),
      ),
    )
    .limit(2)
  const donos = new Set(
    [...owners.map((o) => o.contactId), ...manuais.map((m) => m.contactId)].filter(
      (id): id is string => !!id,
    ),
  )
  // Cadastro do Asaas dividido entre dois contatos: não dá para saber de quem
  // é o pagamento, então ninguém é despausado.
  if (donos.size !== 1) return 'none'
  const contactId = [...donos][0]
  const aberta = firstOrNull(
    await db
      .select({ id: asaasCharges.id })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, contactId), eq(asaasCharges.open, true)))
      .limit(1),
  )
  if (aberta) return 'none'
  return settlePauseAfterPayment({
    accountId,
    contactId,
    firstSettle: true,
    stillOwes: false,
    nowIso: new Date().toISOString(),
    countOpenInAsaas: () => openPaymentsInAsaas(accountId, contactId, connectionId, customerId),
    noteWhenKept: false,
  })
}

/** Teto da conferência no Asaas dentro do webhook: o Asaas espera a resposta
 *  e marca falha (e pausa a fila) quando ela demora. */
const OPEN_CHECK_BUDGET_MS = 6_000

/**
 * Cobranças em aberto no Asaas (a vencer + vencidas) de TODOS os cadastros
 * deste contato, em todas as contas ligadas — a carteira só tem as vencidas.
 * null = alguma consulta falhou ou estourou o teto (quem chama não tira a
 * pausa no escuro; ela continua na lista "Régua parada sem cobrança vencida").
 */
async function openPaymentsInAsaas(
  accountId: string,
  contactId: string,
  eventConnectionId: string,
  eventCustomerId: string | null,
): Promise<number | null> {
  const deadline = Date.now() + OPEN_CHECK_BUDGET_MS
  try {
    const pairs = new Map<string, Set<string>>()
    const add = (conn: string, cus: string | null) => {
      if (!cus) return
      const set = pairs.get(conn) ?? new Set<string>()
      set.add(cus)
      pairs.set(conn, set)
    }
    add(eventConnectionId, eventCustomerId)
    const known = await db
      .selectDistinct({ connectionId: asaasCharges.connectionId, customerId: asaasCharges.asaasCustomerId })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, contactId), isNotNull(asaasCharges.asaasCustomerId)))
    for (const k of known) add(k.connectionId, k.customerId)
    // 🔗 23/09: cadastro ligado à mão na carteira conta igual. Sem isto, um
    // contato vinculado sem cobrança espelhada parecia não dever nada no Asaas
    // — e a régua era liberada com dívida em aberto do outro lado.
    const vinculados = await db
      .select({ connectionId: asaasCustomerLinks.connectionId, customerId: asaasCustomerLinks.asaasCustomerId })
      .from(asaasCustomerLinks)
      .where(and(eq(asaasCustomerLinks.accountId, accountId), eq(asaasCustomerLinks.contactId, contactId)))
    for (const v of vinculados) add(v.connectionId, v.customerId)
    if (!pairs.size) return null
    const linked = await db
      .select({ id: asaasConnections.id, apiKeyEnc: asaasConnections.apiKeyEnc, environment: asaasConnections.environment })
      .from(asaasConnections)
      .where(and(eq(asaasConnections.accountId, accountId), eq(asaasConnections.enabled, true), inArray(asaasConnections.id, [...pairs.keys()])))
    // Conta desligada não conta (chave pode estar revogada: travaria para
    // sempre); sandbox só vale quando não há produção — cobrança de teste
    // ninguém paga (mesma regra do connection-pick).
    const conns = linked.some((c) => c.environment === 'production') ? linked.filter((c) => c.environment === 'production') : linked
    if (!conns.length) return null
    let total = 0
    for (const c of conns) {
      const cred = { apiKey: decrypt(c.apiKeyEnc), environment: c.environment as AsaasEnv }
      for (const cus of pairs.get(c.id) ?? []) {
        const left = deadline - Date.now()
        if (left < 500) return null
        const n = await countOpenPaymentsForCustomer(cred, cus, Math.min(4_000, left))
        if (n === null) return null
        total += n
      }
    }
    return total
  } catch (err) {
    console.error('[cobranca] conferir parcelas em aberto no Asaas falhou:', err instanceof Error ? err.message : err)
    return null
  }
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
