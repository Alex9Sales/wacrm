// ============================================================
// 🔗 Aviso de COBRANÇA NOVA — o CRM viu no Asaas uma cobrança que ele mesmo
// não criou e manda o link para o cliente.
//
// Por que existe (11/09, João/GoLink — cobrança de teste do Sérgio Lemes):
// ele criou a cobrança direto no painel do Asaas e o cliente não recebeu nada.
// Três comportamentos corretos somando silêncio:
//   1. os avisos do Asaas estão DESLIGADOS (a pedido dele, pra não pagar a
//      taxa por notificação — `asaasNotificationsOff`);
//   2. a cobrança não nasceu no CRM, então ninguém mandou o link na criação;
//   3. a régua só fala quando passa do atraso mínimo da conta.
// Quem calou o Asaas precisa falar no lugar dele. É isso que esta varredura faz.
//
// Travas, porque aqui o erro é caro (blast):
//   · só quando a conta assumiu os avisos (`asaasNotificationsOff`);
//   · só cobrança que o CRM NÃO criou (`origin='sync'`) — a que ele cria já
//     manda o link na hora;
//   · só o que ele viu AGORA (janela curta) e nunca numa conexão recém-ligada,
//     senão ligar o Asaas com 200 cobranças em aberto viraria 200 mensagens;
//   · uma vez por cobrança, para sempre;
//   · respeita opt-out, devedor pausado, teto do dia, política e a cadência
//     (entra na MESMA fila da régua, uma a cada N minutos).
//
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'

import { db, agentActionRequests, asaasCharges, asaasConnections, collectionsTouches, contacts, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { decide, type AutonomyPolicy } from '@/lib/orchestration/policy'
import type { AccountSettings } from '@/lib/settings/account-settings'

import { newChargesMessage, type NewChargeLine } from './emit-rules'
import { resolveCollectionTargets } from './outreach'
import { greetingName, type CollectionsSettings } from './rules'

/**
 * Quanto tempo depois de a cobrança NASCER NO ASAAS o aviso ainda faz sentido.
 * Curto de propósito: o que está parado há dias não é novidade, é dívida — e
 * dívida é trabalho da régua.
 *
 * ⚠️ Conta pela data do ASAAS (`asaasCreatedAt`), nunca pela data da nossa
 * linha: numa ressincronização o `createdAt` nosso vira "hoje" para cobrança
 * de junho. A simulação de 11/09 na GoLink mostrou isso — 56 candidatas pela
 * data da linha, 37 delas de meses atrás.
 */
const JANELA_DIAS = 2

/**
 * Conexão ligada há pouco ainda está fazendo carga inicial: tudo que ela tem é
 * histórico, não cobrança nova. Ligar o Asaas com 200 em aberto não pode virar
 * 200 mensagens.
 */
const CONEXAO_NOVA_MS = 3 * 24 * 3_600_000

export interface NewChargeRunResult {
  queued: number
  found: number
  skipped: Partial<Record<'conexao_nova' | 'ja_avisado' | 'sem_contato' | 'opt_out' | 'pausado' | 'sem_canal' | 'politica' | 'teto', number>>
}

export async function queueNewChargeNotices(args: {
  accountId: string
  settings: CollectionsSettings
  accountSettings: AccountSettings
  policy: AutonomyPolicy
  agentId: string | null
  /** Quantas ainda cabem no teto do dia. */
  budget: number
  /** Contatos que já têm pedido nesta rodada — não mandamos dois. */
  alreadyQueued: Set<string>
  usedToday: number
  now?: Date
}): Promise<NewChargeRunResult> {
  const out: NewChargeRunResult = { queued: 0, found: 0, skipped: {} }
  const bump = (k: keyof NewChargeRunResult['skipped']) => {
    out.skipped[k] = (out.skipped[k] ?? 0) + 1
  }
  const s = args.settings
  // Asaas ainda avisando = ele já manda o link. Dois avisos é pior que nenhum.
  if (!s.asaasNotificationsOff || args.budget <= 0) return out

  const now = args.now ?? new Date()
  const desdeDia = new Date(now.getTime() - JANELA_DIAS * 86_400_000).toISOString().slice(0, 10)

  // Conexões maduras: ligadas há mais que a janela de carga inicial.
  const conexoesOk = await db
    .select({ id: asaasConnections.id })
    .from(asaasConnections)
    .where(
      and(
        eq(asaasConnections.accountId, args.accountId),
        eq(asaasConnections.enabled, true),
        lt(asaasConnections.createdAt, new Date(now.getTime() - CONEXAO_NOVA_MS).toISOString()),
      ),
    )
  if (!conexoesOk.length) return out
  const conexaoMadura = new Set(conexoesOk.map((c) => c.id))

  const novas = await db
    .select({
      id: asaasCharges.id,
      asaasId: asaasCharges.asaasId,
      connectionId: asaasCharges.connectionId,
      contactId: asaasCharges.contactId,
      customerName: asaasCharges.customerName,
      value: asaasCharges.value,
      dueDate: asaasCharges.dueDate,
      description: asaasCharges.description,
      invoiceUrl: asaasCharges.invoiceUrl,
    })
    .from(asaasCharges)
    .where(
      and(
        eq(asaasCharges.accountId, args.accountId),
        eq(asaasCharges.open, true),
        eq(asaasCharges.origin, 'sync'),
        isNotNull(asaasCharges.contactId),
        isNotNull(asaasCharges.invoiceUrl),
        // A data do ASAAS, não a nossa. Cobrança sem essa data (sincronizada
        // antes da migração 0168) fica de fora — não dá para saber a idade
        // dela, e na dúvida o certo é calar.
        isNotNull(asaasCharges.asaasCreatedAt),
        gte(asaasCharges.asaasCreatedAt, desdeDia),
      ),
    )
  out.found = novas.length
  if (!novas.length) return out

  // Uma vez por cobrança, para sempre: o que já foi avisado não volta.
  const jaAvisado = new Set<string>()
  const anteriores = await db
    .select({ payload: agentActionRequests.payload })
    .from(agentActionRequests)
    .where(
      and(
        eq(agentActionRequests.accountId, args.accountId),
        eq(agentActionRequests.actionType, 'collect_charges'),
        sql`${agentActionRequests.payload}->>'kind' = 'new_charge'`,
      ),
    )
  for (const r of anteriores) {
    const list = (r.payload as { asaasIds?: unknown } | null)?.asaasIds
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') jaAvisado.add(id)
  }

  interface Candidato {
    contactId: string
    connectionId: string
    nomeAsaas: string | null
    asaasIds: string[]
    linhas: NewChargeLine[]
  }
  const porContato = new Map<string, Candidato>()
  for (const n of novas) {
    if (!conexaoMadura.has(n.connectionId)) {
      bump('conexao_nova')
      continue
    }
    if (jaAvisado.has(n.asaasId)) {
      bump('ja_avisado')
      continue
    }
    const contactId = n.contactId!
    if (args.alreadyQueued.has(contactId)) {
      bump('ja_avisado')
      continue
    }
    let c = porContato.get(contactId)
    if (!c) {
      c = { contactId, connectionId: n.connectionId, nomeAsaas: n.customerName, asaasIds: [], linhas: [] }
      porContato.set(contactId, c)
    }
    c.asaasIds.push(n.asaasId)
    c.linhas.push({
      value: Number(n.value ?? 0),
      dueDate: (n.dueDate ?? '').slice(0, 10),
      description: n.description ?? '',
      url: n.invoiceUrl!,
    })
  }
  if (!porContato.size) return out

  const ids = [...porContato.keys()]
  const fichas = await db
    .select({ id: contacts.id, name: contacts.name, optedOut: contacts.optedOut })
    .from(contacts)
    .where(and(eq(contacts.accountId, args.accountId), inArray(contacts.id, ids)))
  const fichaPor = new Map(fichas.map((r) => [r.id, r]))

  const pausados = await db
    .select({ contactId: collectionsTouches.contactId })
    .from(collectionsTouches)
    .where(and(eq(collectionsTouches.accountId, args.accountId), eq(collectionsTouches.paused, true), inArray(collectionsTouches.contactId, ids)))
  const pausado = new Set(pausados.map((r) => r.contactId))

  let budget = args.budget
  let usedToday = args.usedToday

  for (const cand of porContato.values()) {
    if (budget <= 0) {
      bump('teto')
      break
    }
    const ficha = fichaPor.get(cand.contactId)
    if (!ficha) {
      bump('sem_contato')
      continue
    }
    if (ficha.optedOut) {
      bump('opt_out')
      continue
    }
    if (pausado.has(cand.contactId)) {
      bump('pausado')
      continue
    }
    const delivery = await resolveCollectionTargets(args.accountId, cand.contactId, null, { dryRun: true })
    if (!delivery.ok) {
      bump('sem_canal')
      continue
    }

    // Nome como está no Asaas prevalece (decisão 10/09); a ficha só cobre o vazio.
    const nomeCompleto = (cand.nomeAsaas ?? '').trim() || ficha.name || null
    const texto = newChargesMessage(greetingName(nomeCompleto), cand.linhas)

    const conv = firstOrNull(
      await db
        .select({ id: conversations.id, aiOff: conversations.aiAutoreplyDisabled })
        .from(conversations)
        .where(and(eq(conversations.accountId, args.accountId), eq(conversations.contactId, cand.contactId)))
        .limit(1),
    )
    const decision = decide({
      action: 'collect_charges',
      policy: args.policy,
      accountPaused: args.accountSettings.autonomyPaused === true,
      accountMode: args.accountSettings.aiMode ?? 'on',
      withinHours: true,
      optedOut: false,
      humanActiveRecently: false,
      aiDisabledInConversation: s.autoSend ? false : conv?.aiOff === true,
      usedToday,
      messagesToday: usedToday,
      usedForDealToday: 0,
    })
    if (decision.decision === 'blocked') {
      bump('politica')
      continue
    }

    await db.insert(agentActionRequests).values({
      accountId: args.accountId,
      agentId: args.agentId,
      contactId: cand.contactId,
      dealId: null,
      conversationId: conv?.id ?? null,
      actionType: 'collect_charges',
      payload: {
        kind: 'new_charge',
        connectionId: cand.connectionId,
        asaasIds: cand.asaasIds,
        charges: cand.linhas.length,
        total: cand.linhas.reduce((acc, l) => acc + l.value, 0),
        touch: 0,
        delivery: delivery.label,
      },
      suggestedText: texto,
      reason:
        (cand.linhas.length === 1 ? 'Cobrança nova no Asaas' : `${cand.linhas.length} cobranças novas no Asaas`) +
        ` que o CRM não criou — o cliente ainda não recebeu o link (os avisos do Asaas estão desligados). Vai por ${delivery.label}.`,
      decision: decision.decision === 'auto_execute' ? 'auto' : decision.decision === 'request_approval' ? 'approve' : 'suggest',
      policy: decision.reason,
      status: 'pending',
    })
    args.alreadyQueued.add(cand.contactId)
    out.queued += 1
    budget -= 1
    usedToday += 1
  }

  return out
}
