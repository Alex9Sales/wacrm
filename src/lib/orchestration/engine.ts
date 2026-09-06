// ============================================================
// 🧠 Fase 2 — ORQUESTRADOR: Signal → NBA → Policy → Action → Approval/Auto → Audit
// (worker-reachable, SEM 'server-only'). Tick por conta:
//
//   1. lê a política do agente padrão (ai_configs.autonomy) + travas da conta;
//   2. pega os sinais abertos que este motor trata (proposal_idle, followup_due,
//      stale_deal, high_intent, churn_risk, ticket_declining, …);
//   3. pra cada sinal: NBA recomenda → policy decide →
//        suggest_only      → chip no card (deal_suggestions)
//        request_approval  → fila "Precisa de você" (agent_action_requests pending) + notificação
//        auto_execute      → executa, registra (status sent/done, resolved_by NULL = IA),
//                            nota no histórico do negócio (por quê) e avisa o vendedor
//        blocked           → registra 1x/24h (auditoria)
//        deferred          → nada (tenta no próximo tick)
//
// Travas de operação: kill switch (conta + agente), horário, opt-out, humano
// recente na conversa, IA off na conversa, teto por ação/24h, teto de
// mensagens/24h, 1 ação automática por negócio/dia, dedupe por
// (contato, ação, negócio) em 48h, circuit breaker (3 falhas seguidas param o
// tick), máximo de execuções automáticas por tick, pacing entre mensagens.
// ============================================================

import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import { db, agentActionRequests, aiConfigs, cadenceEnrollments, contacts, conversations, customerSignals, dealProposals, dealSuggestions, deals, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadAiConfigById } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { greeting } from '@/lib/cdl/names'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { isWithinBusinessHours } from '@/lib/settings/business-hours'

import { executeOrchestrationAction, noteDealEvent, notifyUsers } from './actions'
import { ORCHESTRATED_SIGNALS, recommend, type Recommendation, type SignalLike } from './nba'
import { ACTION_CATALOG, decide, readPolicy, type AutonomyPolicy, type OrchAction } from './policy'

const MAX_AUTO_PER_RUN = 5
const MAX_NOTIFY_PER_RUN = 3
/** Mensagens AUTOMÁTICAS por tique (10 min): anti-rajada, o mesmo espírito dos Disparos (item 7 da auditoria de cobrança, 06/09). */
const MAX_AUTO_MESSAGES_PER_RUN = 3
const MAX_SUGGESTIONS_PER_RUN = 50
/** Entre duas mensagens automáticas no mesmo tique: 60–120s com jitter — nada de 1/segundo numa linha de WhatsApp. */
const PACE_MIN_MS = 60_000
const PACE_JITTER_MS = 60_000
const DEDUPE_HOURS = 48
/** Aviso ao time repete no máximo 1x por semana por (contato, ação, negócio). */
const DEDUPE_NOTIFY_HOURS = 24 * 7
const BLOCKED_LOG_HOURS = 24
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

export interface RunStats {
  signals: number
  auto: number
  approvals: number
  suggestions: number
  blocked: number
  failed: number
  skipped: string | null
}

function localHour(tz: string): number {
  try {
    const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()), 10)
    return Number.isFinite(h) ? h % 24 : -1
  } catch {
    return -1
  }
}

function key(contactId: string, action: string, dealId: string | null): string {
  return `${contactId}|${action}|${dealId ?? ZERO_UUID}`
}

/** Rascunho DETERMINÍSTICO (fallback sem LLM). */
export function draftFallback(action: OrchAction, rec: Recommendation, contactName: string | null, payload: Record<string, unknown>): string {
  const oi = greeting(contactName)
  const title = typeof payload.deal_title === 'string' && payload.deal_title ? ` sobre ${payload.deal_title}` : ''
  if (action === 'reactivation') {
    const prod = payload.product ? String(payload.product) : 'seu pedido'
    return `${oi} 😊 Faz um tempinho que a gente não se fala. Tá precisando de ${prod}? Posso te ajudar agora mesmo.`
  }
  if (rec.headline.startsWith('Enviar follow-up: proposta')) {
    return `${oi} Passando pra saber se conseguiu ver a proposta${title}. Ficou alguma dúvida que eu possa esclarecer?`
  }
  if (rec.headline.includes('fechamento')) {
    return `${oi} Vi que você está bem perto de decidir${title}. Quer que eu te ajude a fechar hoje?`
  }
  return `${oi} Tudo bem? Só passando pra retomar nossa conversa${title}. Como posso te ajudar a avançar?`
}

/** Rascunho com o agente da conta (curto, pt-BR); cai no fallback se não der. */
async function draftMessage(args: {
  accountId: string
  agentId: string | null
  action: OrchAction
  rec: Recommendation
  contactName: string | null
  payload: Record<string, unknown>
  conversationId: string | null
}): Promise<string> {
  const fallback = draftFallback(args.action, args.rec, args.contactName, args.payload)
  if (!args.agentId) return fallback
  try {
    const config = await loadAiConfigById(args.accountId, args.agentId, { requireActive: false })
    if (!config) return fallback
    let recent = ''
    if (args.conversationId) {
      const rows = await db
        .select({ senderType: messages.senderType, text: messages.contentText, at: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, args.conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(8)
      recent = rows
        .reverse()
        .map((m) => `${m.senderType === 'customer' ? 'Cliente' : 'Nós'}: ${(m.text ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
        .join('\n')
    }
    const system = [
      'Você é a assistente comercial da empresa no WhatsApp. Escreva UMA mensagem curta (até 350 caracteres), natural, em português do Brasil, sem markdown, sem assinatura, sem emojis em excesso (no máximo 1).',
      'Objetivo da mensagem: ' + args.rec.headline + '. Motivo interno (não copie literalmente): ' + args.rec.reason,
      args.contactName ? `Nome do cliente: ${args.contactName}. Use só o primeiro nome.` : 'Não sabemos o nome do cliente.',
      'Não invente preços, prazos ou promessas. Termine com uma pergunta simples que facilite a resposta.',
      recent ? `Últimas mensagens da conversa:\n${recent}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const r = await generateReply({
      config,
      systemPrompt: system,
      messages: [{ role: 'user', content: 'Escreva a mensagem agora.' }] as unknown as Parameters<typeof generateReply>[0]['messages'],
    })
    const out = r as unknown as { text?: string; content?: string; error?: unknown }
    const text = (out.text ?? out.content ?? '').toString().trim()
    if (!text || out.error) return fallback
    return text.slice(0, 600)
  } catch {
    return fallback
  }
}

interface SignalRow {
  id: string
  contactId: string
  dealId: string | null
  signalType: string
  severity: number
  payload: Record<string, unknown>
}

/**
 * 🎯 A próxima ação recomendada PRA ESTE CONTATO, em uma linha, pro prompt do
 * agente que está atendendo. Sem isso a IA responde no vácuo enquanto o CRM já
 * sabe que existe proposta parada / follow-up vencido / cliente quente sem
 * proposta. É ORIENTAÇÃO interna: o texto nunca vai pro cliente.
 * Best-effort e barato (1 query indexada) — falha vira null.
 */
export async function nextActionHintForContact(
  accountId: string,
  contactId: string,
): Promise<string | null> {
  try {
    const rows = (await db
      .select({
        id: customerSignals.id,
        contactId: customerSignals.contactId,
        dealId: customerSignals.dealId,
        signalType: customerSignals.signalType,
        severity: customerSignals.severity,
        payload: customerSignals.payload,
      })
      .from(customerSignals)
      .where(
        and(
          eq(customerSignals.accountId, accountId),
          eq(customerSignals.contactId, contactId),
          isNull(customerSignals.resolvedAt),
          inArray(customerSignals.signalType, [...ORCHESTRATED_SIGNALS]),
        ),
      )
      .orderBy(desc(customerSignals.severity))
      .limit(1)) as SignalRow[]
    const s = rows[0]
    if (!s) return null

    let deal: { title: string; assignedTo: string | null; conversationId: string | null; status: string | null } | null = null
    let hasProposal = false
    let proposalAccepted = false
    if (s.dealId) {
      deal =
        firstOrNull(
          await db
            .select({ title: deals.title, assignedTo: deals.assignedTo, conversationId: deals.conversationId, status: deals.status })
            .from(deals)
            .where(eq(deals.id, s.dealId))
            .limit(1),
        ) ?? null
      if (!deal || deal.status !== 'open') return null
      const pr = firstOrNull(
        await db.select({ acceptedAt: dealProposals.acceptedAt }).from(dealProposals).where(eq(dealProposals.dealId, s.dealId)).limit(1),
      )
      hasProposal = !!pr
      proposalAccepted = !!pr?.acceptedAt
    }
    const rec = recommend(
      { id: s.id, signalType: s.signalType, severity: s.severity, payload: s.payload ?? {}, contactId: s.contactId, dealId: s.dealId },
      {
        hasProposal,
        proposalAccepted,
        hasConversation: true,
        dealAssigned: !!deal?.assignedTo,
        contactName: null,
        dealTitle: deal?.title ?? null,
      },
    )
    if (!rec) return null
    return `${rec.headline} — ${rec.reason}`
  } catch {
    return null
  }
}

export async function runOrchestrationForAccount(accountId: string): Promise<RunStats> {
  const stats: RunStats = { signals: 0, auto: 0, approvals: 0, suggestions: 0, blocked: 0, failed: 0, skipped: null }
  const settings = await getAccountSettings(accountId)
  const agent = firstOrNull(
    await db
      .select({ id: aiConfigs.id, autonomy: aiConfigs.autonomy, createdBy: aiConfigs.createdBy })
      .from(aiConfigs)
      // A política é CONFIGURAÇÃO: vale mesmo com o agente desligado (auto-resposta off).
      // Preferimos o padrão ativo; senão o padrão inativo (caso Rafael Odonto, QA da Fase 2).
      .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
      .orderBy(desc(aiConfigs.isActive))
      .limit(1),
  )
  const policy: AutonomyPolicy = readPolicy(agent?.autonomy ?? null)
  const tz = settings.businessTimezone || 'America/Sao_Paulo'
  const withinHours = settings.businessHoursEnabled ? isWithinBusinessHours(settings) : (() => {
    const h = localHour(tz)
    return h >= 8 && h < 20
  })()

  // 🧹 Pendente que perdeu o motivo (o cliente respondeu, o negócio andou, a
  // proposta foi aceita) sai da fila como 'expired' — sem isso o time abre
  // "Precisa de você" e vê follow-up pra quem já respondeu.
  try {
    await db
      .update(agentActionRequests)
      .set({ status: 'expired', resolvedAt: new Date().toISOString() })
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.status, 'pending'),
          isNotNull(agentActionRequests.signalId),
          sql`EXISTS (
            SELECT 1 FROM customer_signals cs
            WHERE cs.id = "agent_action_requests"."signal_id" AND cs.resolved_at IS NOT NULL
          )`,
        ),
      )
  } catch (err) {
    console.error('[orchestration] expirar pendentes falhou:', err instanceof Error ? err.message : err)
  }

  const signals = (await db
    .select({
      id: customerSignals.id,
      contactId: customerSignals.contactId,
      dealId: customerSignals.dealId,
      signalType: customerSignals.signalType,
      severity: customerSignals.severity,
      payload: customerSignals.payload,
    })
    .from(customerSignals)
    .where(and(eq(customerSignals.accountId, accountId), isNull(customerSignals.resolvedAt), inArray(customerSignals.signalType, [...ORCHESTRATED_SIGNALS])))
    .orderBy(desc(customerSignals.severity), desc(customerSignals.detectedAt))
    .limit(200)) as SignalRow[]
  stats.signals = signals.length
  if (signals.length === 0) return stats

  // ---- contexto em lote
  const contactIds = Array.from(new Set(signals.map((s) => s.contactId)))
  const dealIds = Array.from(new Set(signals.map((s) => s.dealId).filter((x): x is string => !!x)))
  const contactRows = await db.select({ id: contacts.id, name: contacts.name, optedOut: contacts.optedOut }).from(contacts).where(inArray(contacts.id, contactIds))
  const contactById = new Map(contactRows.map((c) => [c.id, c]))
  const dealRows = dealIds.length
    ? await db
        .select({ id: deals.id, title: deals.title, assignedTo: deals.assignedTo, conversationId: deals.conversationId, status: deals.status })
        .from(deals)
        .where(inArray(deals.id, dealIds))
    : []
  const dealById = new Map(dealRows.map((d) => [d.id, d]))
  const proposalRows = dealIds.length
    ? await db.select({ dealId: dealProposals.dealId, acceptedAt: dealProposals.acceptedAt }).from(dealProposals).where(inArray(dealProposals.dealId, dealIds))
    : []
  const proposalByDeal = new Map(proposalRows.map((p) => [p.dealId, p]))
  const convIds = Array.from(new Set(dealRows.map((d) => d.conversationId).filter((x): x is string => !!x)))
  const convRows = convIds.length
    ? await db.select({ id: conversations.id, assigned: conversations.assignedAgentId, aiOff: conversations.aiAutoreplyDisabled }).from(conversations).where(inArray(conversations.id, convIds))
    : []
  const convById = new Map(convRows.map((c) => [c.id, c]))
  const humanCutoff = new Date(Date.now() - policy.humanCooldownHours * 3_600_000).toISOString()
  const humanRecent = new Set<string>()
  if (convIds.length && policy.humanCooldownHours > 0) {
    const rows = await db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(and(inArray(messages.conversationId, convIds), eq(messages.senderType, 'agent'), gte(messages.createdAt, humanCutoff)))
      .groupBy(messages.conversationId)
    for (const r of rows) if (r.conversationId) humanRecent.add(r.conversationId)
  }

  // ---- contadores das últimas 24h (execuções automáticas) + dedupe recente
  const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const autoRows = await db
    .select({ actionType: agentActionRequests.actionType, dealId: agentActionRequests.dealId })
    .from(agentActionRequests)
    .where(
      and(
        eq(agentActionRequests.accountId, accountId),
        isNull(agentActionRequests.resolvedBy),
        inArray(agentActionRequests.status, ['sent', 'done']),
        gte(agentActionRequests.resolvedAt, dayAgo),
      ),
    )
  const usedByAction = new Map<string, number>()
  const usedByDeal = new Map<string, number>()
  let messagesToday = 0
  for (const r of autoRows) {
    usedByAction.set(r.actionType, (usedByAction.get(r.actionType) ?? 0) + 1)
    if (r.dealId) usedByDeal.set(r.dealId, (usedByDeal.get(r.dealId) ?? 0) + 1)
    const meta = ACTION_CATALOG[r.actionType as OrchAction]
    if (meta?.kind === 'message') messagesToday += 1
  }
  // Quem já está numa cadência ativa não entra em outra.
  const activeCadenceContacts = new Set<string>()
  if (policy.staleCadenceId) {
    try {
      const rows = await db
        .select({ contactId: cadenceEnrollments.contactId })
        .from(cadenceEnrollments)
        .where(and(eq(cadenceEnrollments.accountId, accountId), eq(cadenceEnrollments.status, 'active')))
      for (const r of rows) activeCadenceContacts.add(r.contactId)
    } catch {
      /* melhor recomendar follow-up do que travar o tick */
    }
  }

  const dedupeCutoff = new Date(Date.now() - DEDUPE_NOTIFY_HOURS * 3_600_000).toISOString()
  const dedupeMsgCutoff = Date.now() - DEDUPE_HOURS * 3_600_000
  const recentRows = await db
    .select({ contactId: agentActionRequests.contactId, actionType: agentActionRequests.actionType, dealId: agentActionRequests.dealId, status: agentActionRequests.status, createdAt: agentActionRequests.createdAt })
    .from(agentActionRequests)
    .where(and(eq(agentActionRequests.accountId, accountId), sql`(${agentActionRequests.status} = 'pending' OR ${agentActionRequests.createdAt} >= ${dedupeCutoff})`))
  const pendingKeys = new Set<string>()
  const recentKeys = new Set<string>()
  const blockedRecent = new Set<string>()
  const blockedCutoff = Date.now() - BLOCKED_LOG_HOURS * 3_600_000
  for (const r of recentRows) {
    const k = key(r.contactId, r.actionType, r.dealId)
    if (r.status === 'pending') pendingKeys.add(k)
    else if (r.status === 'blocked') {
      if (new Date(r.createdAt).getTime() >= blockedCutoff) blockedRecent.add(k)
    } else {
      // aviso: janela de 7 dias; mensagem/CRM: 48h
      const isNotify = ACTION_CATALOG[r.actionType as OrchAction]?.kind === 'notify'
      if (isNotify || new Date(r.createdAt).getTime() >= dedupeMsgCutoff) recentKeys.add(k)
    }
  }
  const pendingSuggestionDeals = new Set(
    dealIds.length
      ? (
          await db
            .select({ dealId: dealSuggestions.dealId })
            .from(dealSuggestions)
            .where(and(eq(dealSuggestions.accountId, accountId), inArray(dealSuggestions.dealId, dealIds), eq(dealSuggestions.status, 'pending'), eq(dealSuggestions.target, 'orchestration')))
        ).map((r) => r.dealId)
      : [],
  )

  let autoRuns = 0
  let messageRuns = 0
  let notifyRuns = 0
  let consecutiveFails = 0
  const adminsNotified = new Set<string>()

  for (const s of signals) {
    if (consecutiveFails >= 3) {
      stats.skipped = 'circuit-breaker'
      break
    }
    const contact = contactById.get(s.contactId)
    const deal = s.dealId ? dealById.get(s.dealId) : null
    if (s.dealId && (!deal || deal.status !== 'open')) continue
    const proposal = s.dealId ? proposalByDeal.get(s.dealId) : undefined
    const conv = deal?.conversationId ? convById.get(deal.conversationId) : undefined
    const sig: SignalLike = { id: s.id, signalType: s.signalType, severity: s.severity, payload: s.payload ?? {}, contactId: s.contactId, dealId: s.dealId }
    const rec = recommend(sig, {
      cadenceConfigured: !!policy.staleCadenceId,
      inCadence: activeCadenceContacts.has(s.contactId),
      hasProposal: !!proposal,
      proposalAccepted: !!proposal?.acceptedAt,
      hasConversation: !!deal?.conversationId,
      dealAssigned: !!deal?.assignedTo,
      contactName: contact?.name ?? null,
      dealTitle: deal?.title ?? null,
    })
    if (!rec) continue
    const k = key(s.contactId, rec.action, s.dealId)
    if (pendingKeys.has(k) || recentKeys.has(k)) continue

    const meta = ACTION_CATALOG[rec.action]
    const d = decide({
      action: rec.action,
      policy,
      accountPaused: !!settings.autonomyPaused,
      accountMode: settings.aiMode ?? 'on',
      withinHours,
      optedOut: !!contact?.optedOut,
      humanActiveRecently: !!(deal?.conversationId && humanRecent.has(deal.conversationId)),
      aiDisabledInConversation: !!conv?.aiOff,
      usedToday: usedByAction.get(rec.action) ?? 0,
      messagesToday,
      usedForDealToday: s.dealId ? (usedByDeal.get(s.dealId) ?? 0) : 0,
    })
    const basePayload = {
      ...(s.payload ?? {}),
      signalType: s.signalType,
      severity: s.severity,
      headline: rec.headline,
      actionLabel: meta.label,
      risk: meta.risk,
      ...(rec.action === 'start_cadence' && policy.staleCadenceId ? { staleCadenceId: policy.staleCadenceId } : {}),
    }

    if (d.decision === 'deferred') continue

    if (d.decision === 'suggest_only') {
      if (s.dealId && !pendingSuggestionDeals.has(s.dealId) && stats.suggestions < MAX_SUGGESTIONS_PER_RUN) {
        await db.insert(dealSuggestions).values({
          accountId,
          dealId: s.dealId,
          // sempre TAREFA: aceitar vira tarefa com este título (kind 'message' enviaria o título como texto)
          kind: 'task',
          target: 'orchestration',
          label: rec.headline,
          value: rec.headline,
          dueAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
          evidence: `${rec.reason} (${d.reason})`,
          createdBy: null,
        })
        pendingSuggestionDeals.add(s.dealId)
        stats.suggestions += 1
      }
      continue
    }

    if (d.decision === 'blocked') {
      // ⚠️ Teto diário atingido é comportamento NORMAL, não bloqueio de
      // política — registrar isso enchia a auditoria (211 linhas na conta do
      // Rafael) e o painel mostrava "Bloqueadas: 211", que assusta à toa.
      // Fica só o que é decisão de verdade: kill switch, opt-out, limite por negócio.
      const isCapOnly = /teto diário/i.test(d.reason)
      if (!isCapOnly && !blockedRecent.has(k)) {
        await db.insert(agentActionRequests).values({
          accountId,
          agentId: agent?.id ?? null,
          contactId: s.contactId,
          dealId: s.dealId,
          conversationId: deal?.conversationId ?? null,
          signalId: s.id,
          actionType: rec.action,
          payload: basePayload,
          reason: rec.reason,
          decision: 'blocked',
          policy: d.reason,
          status: 'blocked',
          resolvedAt: new Date().toISOString(),
        })
        blockedRecent.add(k)
        stats.blocked += 1
      }
      continue
    }

    const text = meta.kind === 'message'
      ? await draftMessage({ accountId, agentId: agent?.id ?? null, action: rec.action, rec, contactName: contact?.name ?? null, payload: s.payload ?? {}, conversationId: deal?.conversationId ?? null })
      : null

    if (d.decision === 'request_approval') {
      const inserted = await db
        .insert(agentActionRequests)
        .values({
          accountId,
          agentId: agent?.id ?? null,
          contactId: s.contactId,
          dealId: s.dealId,
          conversationId: deal?.conversationId ?? null,
          signalId: s.id,
          actionType: rec.action,
          payload: basePayload,
          suggestedText: text,
          reason: rec.reason,
          decision: 'approve',
          policy: d.reason,
          status: 'pending',
        })
        .onConflictDoNothing()
        .returning({ id: agentActionRequests.id })
      if (inserted.length) {
        pendingKeys.add(k)
        stats.approvals += 1
        const targets = deal?.assignedTo ? [deal.assignedTo] : []
        const who = contact?.name ? ` — ${contact.name}` : ''
        if (targets.length) {
          await notifyUsers({ accountId, userIds: targets, type: 'approval_required', title: `Aprovar: ${meta.label}${who}`, body: rec.reason, contactId: s.contactId, dealId: s.dealId, conversationId: deal?.conversationId ?? null })
        } else if (!adminsNotified.has('admins')) {
          // sem dono: avisa os admins UMA vez por tick
          const { member: memberTable } = await import('@/db')
          const admins = await db.select({ userId: memberTable.userId }).from(memberTable).where(and(eq(memberTable.organizationId, accountId), inArray(memberTable.role, ['owner', 'admin'])))
          await notifyUsers({ accountId, userIds: admins.map((a) => a.userId), type: 'approval_required', title: 'A Fluxia tem ações esperando sua aprovação', body: 'Abra "Precisa de você" pra revisar.', contactId: s.contactId })
          adminsNotified.add('admins')
        }
      }
      continue
    }

    // ---- auto_execute
    if (autoRuns >= MAX_AUTO_PER_RUN) {
      stats.skipped = 'max-per-run'
      continue
    }
    if (meta.kind === 'notify' && notifyRuns >= MAX_NOTIFY_PER_RUN) continue
    if (meta.kind === 'message') {
      if (messageRuns >= MAX_AUTO_MESSAGES_PER_RUN) {
        stats.skipped = 'max-messages-per-run'
        continue
      }
      if (messageRuns > 0) await new Promise((r) => setTimeout(r, PACE_MIN_MS + Math.random() * PACE_JITTER_MS))
      messageRuns += 1
    }
    autoRuns += 1
    if (meta.kind === 'notify') notifyRuns += 1
    const exec = await executeOrchestrationAction({
      accountId,
      actorUserId: null,
      agentId: agent?.id ?? null,
      action: rec.action,
      contactId: s.contactId,
      dealId: s.dealId,
      conversationId: deal?.conversationId ?? null,
      text,
      reason: rec.reason,
      payload: basePayload,
    })
    const now = new Date().toISOString()
    if (exec.ok) {
      consecutiveFails = 0
      await db.insert(agentActionRequests).values({
        accountId,
        agentId: agent?.id ?? null,
        contactId: s.contactId,
        dealId: s.dealId,
        conversationId: deal?.conversationId ?? null,
        signalId: s.id,
        actionType: rec.action,
        payload: { ...basePayload, auto: true },
        suggestedText: text,
        reason: rec.reason,
        decision: 'auto',
        policy: d.reason,
        status: meta.kind === 'message' ? 'sent' : 'done',
        executedAt: now,
        resolvedAt: now,
        resolvedBy: null,
        result: exec.result ?? {},
        // guarda o estado anterior — é o que o "Desfazer" da auditoria usa
        revertState: exec.revertState ?? null,
      })
      recentKeys.add(k)
      usedByAction.set(rec.action, (usedByAction.get(rec.action) ?? 0) + 1)
      if (s.dealId) usedByDeal.set(s.dealId, (usedByDeal.get(s.dealId) ?? 0) + 1)
      if (meta.kind === 'message') messagesToday += 1
      stats.auto += 1
      // sinal atendido (o detector reabre se a condição voltar)
      await db.update(customerSignals).set({ resolvedAt: now, updatedAt: now }).where(eq(customerSignals.id, s.id))
      if (s.dealId) {
        await noteDealEvent(accountId, s.dealId, null, `🤖 ${meta.label} feito automaticamente pela Fluxia. Por quê: ${rec.reason} Política: ${d.reason}.`)
      }
      if (meta.kind === 'message' && deal?.assignedTo) {
        await notifyUsers({ accountId, userIds: [deal.assignedTo], type: 'agent_action', title: `Fluxia enviou: ${meta.label}${contact?.name ? ` — ${contact.name}` : ''}`, body: rec.reason, contactId: s.contactId, dealId: s.dealId, conversationId: deal?.conversationId ?? null })
      }
    } else {
      consecutiveFails += 1
      stats.failed += 1
      await db.insert(agentActionRequests).values({
        accountId,
        agentId: agent?.id ?? null,
        contactId: s.contactId,
        dealId: s.dealId,
        conversationId: deal?.conversationId ?? null,
        signalId: s.id,
        actionType: rec.action,
        payload: basePayload,
        suggestedText: text,
        reason: rec.reason,
        decision: 'auto',
        policy: d.reason,
        status: 'failed',
        error: (exec.error ?? 'falha desconhecida').slice(0, 500),
        attempts: 1,
        resolvedAt: now,
      })
      recentKeys.add(k)
    }
  }
  return stats
}
