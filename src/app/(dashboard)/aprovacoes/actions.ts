'use server'

// ============================================================
// "Precisa de você" — fila ÚNICA das ações da IA que exigem aprovação
// (todos os tipos: follow-up, reativação, proposta, desconto, fechar, mover…).
// Aprovar executa a ação COM o usuário que aprovou (auditoria: resolved_by).
// Ações "só humano" rodam pelas Server Actions do app (efeitos completos).
// Erros esperados voltam como { ok:false, error } (throw vira "digest" em prod).
// ============================================================

import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { db, agentActionRequests, channels, contacts, conversations, customerSignals, dealProducts, dealProposals, deals, decisionFeedback, pipelineStages, user } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { getAccountSettings, updateAccountSettings } from '@/lib/settings/account-settings'
import { enqueueOrchestrationNudge } from '@/lib/queue/queues'
import { executeOrchestrationAction, noteDealEvent } from '@/lib/orchestration/actions'
import { ACTION_CATALOG, type OrchAction, type Risk } from '@/lib/orchestration/policy'
import { REASON_CODES, REVERT_MATRIX, contextFingerprint, type RevertKind } from '@/lib/orchestration/revert'
import { revertOrchestrationAction } from '@/lib/orchestration/revert-actions'
import { loadDealProposalFields } from '@/lib/proposals/proposal'
import { saveDealProposal, sendDealProposalEmail, setDealStatus } from '@/app/(dashboard)/pipelines/actions'

export interface ApprovalItem {
  id: string
  action: OrchAction
  actionLabel: string
  actionHint: string
  risk: Risk
  isMessage: boolean
  humanOnly: boolean
  contact: { id: string; name: string | null; phone: string | null }
  deal: { id: string; title: string; value: string; stageName: string | null } | null
  conversationId: string | null
  suggestedText: string | null
  reason: string | null
  policy: string | null
  payload: Record<string, unknown>
  error: string | null
  attempts: number
  createdAt: string
  /** O que a Fluxia vai fazer se aprovar (em português, concreto). */
  effect: string
  /** Pré-requisitos que faltam (aprovar vai falhar). */
  warnings: string[]
  /** Link da proposta salva (pública), quando houver. */
  proposalUrl: string | null
  contactEmail: string | null
  /** Valor sugerido pra montar a proposta (editável antes de aprovar). */
  proposalValue: number | null
  /** Itens já lançados no negócio (0 = a proposta vai nascer com 1 item do valor). */
  dealItemCount: number
  /** Conversas do contato por onde a mensagem PODE sair (ações de mensagem). */
  sendOptions: { conversationId: string; label: string }[]
  /** A conversa que será usada se não trocar (a do negócio, senão a mais recente). */
  defaultConversationId: string | null
}

export interface AutonomyMetrics {
  days: number
  pending: number
  autoExecuted: number
  approved: number
  rejected: number
  blocked: number
  failed: number
  /** aprovadas / (aprovadas + recusadas), 0–100 */
  approvalRate: number
  /** % das ações executadas (auto + aprovadas) que foram automáticas */
  autoShare: number
  /** Negócios GANHOS no período que tiveram ação da IA antes do ganho. */
  influencedWon: number
  /** Soma do valor desses negócios (receita influenciada). */
  influencedRevenue: number
}

export type ActionResult = { ok: true } | { ok: false; error: string }

function isOrchAction(v: string): v is OrchAction {
  return Object.prototype.hasOwnProperty.call(ACTION_CATALOG, v)
}

/** Fila pendente da conta (todas as ações), mais antigas primeiro. */
export async function listApprovalQueue(): Promise<ApprovalItem[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: agentActionRequests.id,
      actionType: agentActionRequests.actionType,
      contactId: agentActionRequests.contactId,
      dealId: agentActionRequests.dealId,
      conversationId: agentActionRequests.conversationId,
      suggestedText: agentActionRequests.suggestedText,
      reason: agentActionRequests.reason,
      policy: agentActionRequests.policy,
      payload: agentActionRequests.payload,
      error: agentActionRequests.error,
      attempts: agentActionRequests.attempts,
      createdAt: agentActionRequests.createdAt,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      contactEmail: contacts.email,
    })
    .from(agentActionRequests)
    .leftJoin(contacts, eq(contacts.id, agentActionRequests.contactId))
    .where(and(eq(agentActionRequests.accountId, ctx.accountId), eq(agentActionRequests.status, 'pending')))
    .orderBy(desc(agentActionRequests.createdAt))
    .limit(200)

  const dealIds = Array.from(new Set(rows.map((r) => r.dealId).filter((x): x is string => !!x)))
  const dealMap = new Map<string, { id: string; title: string; value: string; stageName: string | null }>()
  if (dealIds.length) {
    const ds = await db
      .select({ id: deals.id, title: deals.title, value: deals.value, stageName: pipelineStages.name })
      .from(deals)
      .leftJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
      .where(and(eq(deals.accountId, ctx.accountId), inArray(deals.id, dealIds)))
    for (const d of ds) dealMap.set(d.id, { id: d.id, title: d.title, value: String(d.value ?? '0'), stageName: d.stageName ?? null })
  }

  // Conversa vinculada ao negócio (define o canal padrão do envio).
  const dealConvByDeal = new Map<string, string | null>()
  if (dealIds.length) {
    const dc = await db
      .select({ id: deals.id, conversationId: deals.conversationId })
      .from(deals)
      .where(and(eq(deals.accountId, ctx.accountId), inArray(deals.id, dealIds)))
    for (const d of dc) dealConvByDeal.set(d.id, d.conversationId ?? null)
  }

  // Conversas do contato + canal (pro seletor "por onde enviar" das ações de mensagem).
  const msgContactIds = Array.from(
    new Set(
      rows
        .filter((r) => isOrchAction(r.actionType) && ACTION_CATALOG[r.actionType as OrchAction].kind === 'message')
        .map((r) => r.contactId),
    ),
  )
  const convsByContact = new Map<string, { conversationId: string; label: string }[]>()
  if (msgContactIds.length) {
    const convs = await db
      .select({
        id: conversations.id,
        contactId: conversations.contactId,
        channelName: channels.name,
        provider: channels.provider,
      })
      .from(conversations)
      .leftJoin(channels, eq(channels.id, conversations.channelId))
      .where(and(eq(conversations.accountId, ctx.accountId), inArray(conversations.contactId, msgContactIds)))
      .orderBy(desc(conversations.lastMessageAt))
    for (const c of convs) {
      const list = convsByContact.get(c.contactId) ?? []
      list.push({ conversationId: c.id, label: channelLabel(c.provider, c.channelName) })
      convsByContact.set(c.contactId, list)
    }
  }

  // Apoio pro "o que acontece ao aprovar": proposta salva + itens (send_proposal), etapas (move_deal).
  const proposalByDeal = new Map<string, { id: string; acceptedAt: string | null }>()
  const itemsByDeal = new Map<string, number>()
  if (dealIds.length) {
    const props = await db.select({ id: dealProposals.id, dealId: dealProposals.dealId, acceptedAt: dealProposals.acceptedAt }).from(dealProposals).where(inArray(dealProposals.dealId, dealIds))
    for (const pr of props) proposalByDeal.set(pr.dealId, { id: pr.id, acceptedAt: pr.acceptedAt })
    const items = await db
      .select({ dealId: dealProducts.dealId, n: sql<number>`count(*)::int` })
      .from(dealProducts)
      .where(inArray(dealProducts.dealId, dealIds))
      .groupBy(dealProducts.dealId)
    for (const it of items) itemsByDeal.set(it.dealId, it.n)
  }

  return rows
    .filter((r) => isOrchAction(r.actionType))
    .map((r) => {
      const meta = ACTION_CATALOG[r.actionType as OrchAction]
      const deal = r.dealId ? (dealMap.get(r.dealId) ?? { id: r.dealId, title: 'Negócio', value: '0', stageName: null }) : null
      const { effect, warnings, proposalUrl } = describeEffect({
        action: r.actionType as OrchAction,
        payload: (r.payload ?? {}) as Record<string, unknown>,
        dealTitle: deal?.title ?? null,
        dealValue: Number(deal?.value ?? 0),
        contactEmail: r.contactEmail ?? null,
        proposal: r.dealId ? (proposalByDeal.get(r.dealId) ?? null) : null,
        items: r.dealId ? (itemsByDeal.get(r.dealId) ?? 0) : 0,
      })
      const isMessage = meta.kind === 'message'
      const sendOptions = isMessage ? (convsByContact.get(r.contactId) ?? []) : []
      const dealConv = r.dealId ? (dealConvByDeal.get(r.dealId) ?? null) : null
      const preferred = r.conversationId ?? dealConv
      const defaultConversationId = isMessage
        ? (sendOptions.find((o) => o.conversationId === preferred)?.conversationId ?? sendOptions[0]?.conversationId ?? null)
        : null
      if (isMessage && sendOptions.length === 0) {
        warnings.push('O contato não tem conversa aberta em nenhum canal — não dá pra enviar. Abra uma conversa com ele primeiro.')
      }
      const itemsOfDeal = r.dealId ? (itemsByDeal.get(r.dealId) ?? 0) : 0
      return {
        effect,
        warnings,
        proposalUrl,
        proposalValue:
          r.actionType === 'draft_proposal' && itemsOfDeal === 0 ? Number(deal?.value ?? 0) || null : null,
        dealItemCount: itemsOfDeal,
        contactEmail: r.contactEmail ?? null,
        sendOptions,
        defaultConversationId,
        id: r.id,
        action: r.actionType as OrchAction,
        actionLabel: meta.label,
        actionHint: meta.hint,
        risk: meta.risk,
        isMessage: meta.kind === 'message',
        humanOnly: !!meta.humanOnly,
        contact: { id: r.contactId, name: r.contactName ?? null, phone: r.contactPhone ?? null },
        deal: r.dealId ? (dealMap.get(r.dealId) ?? { id: r.dealId, title: 'Negócio', value: '0', stageName: null }) : null,
        conversationId: r.conversationId,
        suggestedText: r.suggestedText,
        reason: r.reason,
        policy: r.policy,
        payload: (r.payload ?? {}) as Record<string, unknown>,
        error: r.error,
        attempts: r.attempts,
        createdAt: r.createdAt,
      }
    })
}

/** Métricas de autonomia da conta nos últimos N dias. */
export async function getAutonomyMetrics(days = 7): Promise<AutonomyMetrics> {
  const ctx = await getCurrentAccount()
  const since = new Date(Date.now() - Math.max(1, Math.min(90, days)) * 86_400_000).toISOString()
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'pending')::int`,
      auto: sql<number>`count(*) filter (where ${agentActionRequests.status} in ('sent','done') and ${agentActionRequests.resolvedBy} is null and ${agentActionRequests.createdAt} >= ${since})::int`,
      approved: sql<number>`count(*) filter (where ${agentActionRequests.status} in ('sent','done') and ${agentActionRequests.resolvedBy} is not null and ${agentActionRequests.createdAt} >= ${since})::int`,
      rejected: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'rejected' and ${agentActionRequests.createdAt} >= ${since})::int`,
      blocked: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'blocked' and ${agentActionRequests.createdAt} >= ${since})::int`,
      failed: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'failed' and ${agentActionRequests.createdAt} >= ${since})::int`,
    })
    .from(agentActionRequests)
    .where(eq(agentActionRequests.accountId, ctx.accountId))
  // 💰 Receita influenciada: negócio GANHO no período que teve pelo menos uma
  // ação da IA (automática ou aprovada) ANTES do ganho. É a métrica que mostra
  // se a autonomia paga a conta — não é atribuição causal, é influência.
  let influencedWon = 0
  let influencedRevenue = 0
  try {
    const inf = await db.execute(sql`
      SELECT count(*)::int AS n, COALESCE(SUM(d.value), 0)::float8 AS total
      FROM deals d
      WHERE d.account_id = ${ctx.accountId}::uuid
        AND d.status = 'won'
        AND d.updated_at >= ${since}
        AND EXISTS (
          SELECT 1 FROM agent_action_requests r
          WHERE r.deal_id = d.id
            AND r.status IN ('sent', 'done')
            AND r.resolved_at <= d.updated_at
        )
    `)
    const first = inf.rows[0] as { n?: number; total?: number } | undefined
    influencedWon = Number(first?.n ?? 0)
    influencedRevenue = Number(first?.total ?? 0)
  } catch (err) {
    console.error('[aprovacoes] receita influenciada falhou:', err instanceof Error ? err.message : err)
  }

  const approved = row?.approved ?? 0
  const rejected = row?.rejected ?? 0
  const auto = row?.auto ?? 0
  return {
    days,
    pending: row?.pending ?? 0,
    autoExecuted: auto,
    approved,
    rejected,
    blocked: row?.blocked ?? 0,
    failed: row?.failed ?? 0,
    approvalRate: approved + rejected > 0 ? Math.round((approved / (approved + rejected)) * 100) : 0,
    autoShare: auto + approved > 0 ? Math.round((auto / (auto + approved)) * 100) : 0,
    influencedWon,
    influencedRevenue,
  }
}

async function loadPending(accountId: string, id: string) {
  return firstOrNull(
    await db
      .select()
      .from(agentActionRequests)
      .where(and(eq(agentActionRequests.id, id), eq(agentActionRequests.accountId, accountId), eq(agentActionRequests.status, 'pending')))
      .limit(1),
  )
}

/** Aprova (e executa) um item. `text` = mensagem editada, se for ação de mensagem. */
export async function approveQueueItem(input: { id: string; text?: string | null; payload?: Record<string, unknown>; conversationId?: string | null; proposalValue?: number | null }): Promise<ActionResult> {
  const ctx = await getCurrentAccount()
  if (ctx.role === 'viewer') return { ok: false, error: 'Seu papel só permite visualizar.' }
  const row = await loadPending(ctx.accountId, input.id)
  if (!row) return { ok: false, error: 'Este pedido não está mais pendente.' }
  if (!isOrchAction(row.actionType)) return { ok: false, error: 'Tipo de ação desconhecido.' }
  const action = row.actionType
  const meta = ACTION_CATALOG[action]
  const payload: Record<string, unknown> = {
    ...((row.payload ?? {}) as Record<string, unknown>),
    ...(input.payload ?? {}),
    ...(typeof input.proposalValue === 'number' && input.proposalValue > 0 ? { proposalValue: input.proposalValue } : {}),
  }
  const text = meta.kind === 'message' ? (input.text ?? row.suggestedText ?? '').trim() : null
  if (meta.kind === 'message' && !text) return { ok: false, error: 'Escreva a mensagem antes de aprovar.' }
  // Canal escolhido na fila: só aceita conversa DESTE contato, desta conta.
  let sendConversationId = row.conversationId
  if (meta.kind === 'message' && input.conversationId) {
    const conv = firstOrNull(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, ctx.accountId), eq(conversations.contactId, row.contactId)))
        .limit(1),
    )
    if (!conv) return { ok: false, error: 'A conversa escolhida não é deste contato.' }
    sendConversationId = conv.id
  }

  let result: Record<string, unknown> = {}
  let revertState: Record<string, unknown> | null = null
  let error: string | null = null
  if (meta.humanOnly) {
    if (!row.dealId) error = 'Esta ação precisa de um negócio.'
    else if (action === 'send_proposal') {
      const r = await sendDealProposalEmail(row.dealId)
      error = r.error
      result = { sentProposal: !r.error }
    } else if (action === 'apply_discount') {
      const pct = Number(payload.discountPct)
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) error = 'Desconto inválido.'
      else {
        const cur = await loadDealProposalFields(ctx.accountId, row.dealId)
        const r = await saveDealProposal(row.dealId, { discount: pct, discountType: 'percent', validUntil: cur.fields.validUntil, terms: cur.fields.terms })
        error = r.error
        result = { discountPct: pct, proposalId: r.id }
      }
    } else if (action === 'close_deal') {
      const status = payload.status === 'won' ? 'won' : 'lost'
      const r = await setDealStatus(row.dealId, status, typeof payload.reason === 'string' ? payload.reason : null)
      error = r.error
      result = { status }
    } else error = 'Ação só-humano não mapeada.'
  } else {
    const r = await executeOrchestrationAction({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      agentId: row.agentId,
      action,
      contactId: row.contactId,
      dealId: row.dealId,
      conversationId: sendConversationId,
      text,
      reason: row.reason ?? meta.label,
      payload,
    })
    if (!r.ok) error = r.error ?? 'Não deu certo.'
    else {
      result = r.result ?? {}
      revertState = r.revertState ?? null
    }
  }

  const now = new Date().toISOString()
  if (error) {
    await db
      .update(agentActionRequests)
      .set({ error: error.slice(0, 500), attempts: (row.attempts ?? 0) + 1 })
      .where(eq(agentActionRequests.id, row.id))
    revalidatePath('/aprovacoes')
    return { ok: false, error }
  }
  await db
    .update(agentActionRequests)
    .set({
      status: meta.kind === 'message' ? 'sent' : 'done',
      suggestedText: text ?? row.suggestedText,
      payload,
      executedAt: now,
      resolvedAt: now,
      resolvedBy: ctx.userId,
      result,
      revertState,
      error: null,
    })
    .where(eq(agentActionRequests.id, row.id))
  if (row.signalId) {
    await db.update(customerSignals).set({ resolvedAt: now, updatedAt: now }).where(and(eq(customerSignals.id, row.signalId), isNull(customerSignals.resolvedAt)))
  }
  if (row.dealId) {
    await noteDealEvent(ctx.accountId, row.dealId, ctx.userId, `✅ ${meta.label} aprovado e executado. Por quê: ${row.reason ?? '—'}`)
  }
  // Aprovou como veio ou EDITOU o texto? A diferença importa pra medir a
  // qualidade da sugestão (editar muito = a IA está escrevendo mal).
  const editou = meta.kind === 'message' && !!row.suggestedText && text !== row.suggestedText.trim()
  await recordDecisionFeedback({
    accountId: ctx.accountId,
    requestId: row.id,
    agentId: row.agentId,
    actionType: action,
    payload,
    decision: editou ? 'edited' : 'approved',
    reasonCode: null,
    reasonText: null,
    decidedBy: ctx.userId,
  })
  // Decisão humana muda o estado: recalcula agora (a fila reflete na hora).
  void enqueueOrchestrationNudge(ctx.accountId, 'approval_decided')
  revalidatePath('/aprovacoes')
  return { ok: true }
}

export async function rejectQueueItem(id: string, note?: string, reasonCode?: string | null): Promise<ActionResult> {
  const ctx = await getCurrentAccount()
  if (ctx.role === 'viewer') return { ok: false, error: 'Seu papel só permite visualizar.' }
  const row = await loadPending(ctx.accountId, id)
  if (!row) return { ok: false, error: 'Este pedido não está mais pendente.' }
  const now = new Date().toISOString()
  await db
    .update(agentActionRequests)
    .set({ status: 'rejected', resolvedAt: now, resolvedBy: ctx.userId, result: note ? { note: note.slice(0, 500) } : null })
    .where(eq(agentActionRequests.id, id))
  if (row.dealId) {
    await noteDealEvent(ctx.accountId, row.dealId, ctx.userId, `🚫 Sugestão da Fluxia recusada (${ACTION_CATALOG[row.actionType as OrchAction]?.label ?? row.actionType}).${note ? ` Motivo: ${note}` : ''}`)
  }
  if (isOrchAction(row.actionType)) {
    await recordDecisionFeedback({
      accountId: ctx.accountId,
      requestId: row.id,
      agentId: row.agentId,
      actionType: row.actionType,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      decision: 'rejected',
      reasonCode: reasonCode ?? null,
      reasonText: note ?? null,
      decidedBy: ctx.userId,
    })
  }
  void enqueueOrchestrationNudge(ctx.accountId, 'approval_rejected')
  revalidatePath('/aprovacoes')
  return { ok: true }
}

/** Histórico recente (executadas/bloqueadas/recusadas) pra auditoria na mesma tela. */
export interface AuditItem {
  id: string
  action: OrchAction
  actionLabel: string
  status: string
  /** Como desfazer/corrigir esta ação (undo | correct | escalate | note_only). */
  revertKind: RevertKind
  revertLabel: string
  revertEffect: string
  /** Já foi revertida/marcada? */
  outcome: string | null
  canRevert: boolean
  decision: string | null
  policy: string | null
  reason: string | null
  contactName: string | null
  dealId: string | null
  byHuman: boolean
  error: string | null
  at: string
}
export async function listRecentAudit(limit = 40): Promise<AuditItem[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: agentActionRequests.id,
      actionType: agentActionRequests.actionType,
      status: agentActionRequests.status,
      decision: agentActionRequests.decision,
      policy: agentActionRequests.policy,
      reason: agentActionRequests.reason,
      dealId: agentActionRequests.dealId,
      conversationId: agentActionRequests.conversationId,
      revertState: agentActionRequests.revertState,
      outcome: agentActionRequests.outcome,
      resolvedBy: agentActionRequests.resolvedBy,
      resolvedAt: agentActionRequests.resolvedAt,
      createdAt: agentActionRequests.createdAt,
      error: agentActionRequests.error,
      contactName: contacts.name,
    })
    .from(agentActionRequests)
    .leftJoin(contacts, eq(contacts.id, agentActionRequests.contactId))
    .where(and(eq(agentActionRequests.accountId, ctx.accountId), isNotNull(agentActionRequests.resolvedAt), gte(agentActionRequests.createdAt, new Date(Date.now() - 14 * 86_400_000).toISOString())))
    .orderBy(desc(agentActionRequests.resolvedAt))
    .limit(Math.max(1, Math.min(200, limit)))
  return rows
    .filter((r) => isOrchAction(r.actionType))
    .map((r) => {
      const plan = REVERT_MATRIX[r.actionType as OrchAction]
      // "Desfazer" de verdade só aparece quando a ação FOI executada, guardou o
      // estado anterior e ainda não foi revertida.
      const executada = r.status === 'sent' || r.status === 'done'
      const canRevert =
        executada && !r.outcome && (plan.kind !== 'undo' || !!r.revertState)
      return {
      revertKind: plan.kind,
      revertLabel: plan.label,
      revertEffect: plan.effect,
      outcome: r.outcome,
      canRevert,
      id: r.id,
      action: r.actionType as OrchAction,
      actionLabel: ACTION_CATALOG[r.actionType as OrchAction].label,
      status: r.status,
      decision: r.decision,
      policy: r.policy,
      reason: r.reason,
      contactName: r.contactName ?? null,
      dealId: r.dealId,
      byHuman: !!r.resolvedBy,
      error: r.error,
      at: r.resolvedAt ?? r.createdAt,
    }
    })
}

/** Desfaz (ou corrige) uma ação já executada + registra o feedback humano. */
export async function revertQueueItem(input: { id: string; reasonCode?: string | null; reasonText?: string | null }): Promise<ActionResult & { done?: string }> {
  const ctx = await getCurrentAccount()
  if (ctx.role === 'viewer') return { ok: false, error: 'Seu papel só permite visualizar.' }
  const row = firstOrNull(
    await db
      .select()
      .from(agentActionRequests)
      .where(and(eq(agentActionRequests.id, input.id), eq(agentActionRequests.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!row) return { ok: false, error: 'Ação não encontrada.' }
  if (!isOrchAction(row.actionType)) return { ok: false, error: 'Tipo de ação desconhecido.' }
  if (row.status !== 'sent' && row.status !== 'done') return { ok: false, error: 'Esta ação não chegou a ser executada.' }
  if (row.outcome) return { ok: false, error: 'Esta ação já foi tratada.' }

  const reason = (input.reasonText ?? '').trim() || REASON_CODES.find((r) => r.code === input.reasonCode)?.label || null
  const r = await revertOrchestrationAction({
    accountId: ctx.accountId,
    actorUserId: ctx.userId,
    action: row.actionType,
    dealId: row.dealId,
    conversationId: row.conversationId,
    revertState: (row.revertState ?? null) as Record<string, unknown> | null,
    reason,
  })
  if (!r.ok) return { ok: false, error: r.error ?? 'Não foi possível desfazer.' }

  const plan = REVERT_MATRIX[row.actionType]
  const outcome = plan.kind === 'undo' ? 'reverted' : plan.kind === 'correct' ? 'corrected' : 'bad_result'
  const now = new Date().toISOString()
  await db
    .update(agentActionRequests)
    .set({ outcome, outcomeReason: reason, revertedAt: now, revertedBy: ctx.userId })
    .where(eq(agentActionRequests.id, row.id))

  await recordDecisionFeedback({
    accountId: ctx.accountId,
    requestId: row.id,
    agentId: row.agentId,
    actionType: row.actionType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    decision: plan.kind === 'undo' ? 'reversed' : 'bad_result',
    reasonCode: input.reasonCode ?? null,
    reasonText: reason,
    decidedBy: ctx.userId,
  })
  revalidatePath('/aprovacoes')
  return { ok: true, done: r.done }
}

/** Registra a decisão humana (aprovou/editou/recusou/reverteu) pro Fluxia parar
 *  de repetir o mesmo tipo de sugestão ruim. Best-effort: nunca derruba a ação. */
async function recordDecisionFeedback(a: {
  accountId: string
  requestId: string
  agentId: string | null
  actionType: OrchAction
  payload: Record<string, unknown>
  decision: 'approved' | 'edited' | 'rejected' | 'reversed' | 'bad_result'
  reasonCode: string | null
  reasonText: string | null
  decidedBy: string
}): Promise<void> {
  try {
    const signalType = typeof a.payload.signalType === 'string' ? a.payload.signalType : null
    const severity = typeof a.payload.severity === 'number' ? a.payload.severity : null
    await db.insert(decisionFeedback).values({
      accountId: a.accountId,
      requestId: a.requestId,
      agentId: a.agentId,
      actionType: a.actionType,
      signalType,
      contextFingerprint: contextFingerprint(a.actionType, signalType, severity),
      decision: a.decision,
      reasonCode: a.reasonCode,
      reasonText: a.reasonText ? a.reasonText.slice(0, 500) : null,
      decidedBy: a.decidedBy,
    })
  } catch (err) {
    console.error('[aprovacoes] feedback não registrado:', err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------- canal / "o que acontece ao aprovar"

const PROVIDER_LABEL: Record<string, string> = {
  waha: 'WhatsApp',
  meta: 'WhatsApp oficial',
  whatsapp: 'WhatsApp',
  evolution: 'WhatsApp',
  evogo: 'WhatsApp',
  instagram: 'Instagram',
  messenger: 'Messenger',
  email: 'E-mail',
  gmail: 'E-mail',
}

function channelLabel(provider: string | null, name: string | null): string {
  const kind = provider ? (PROVIDER_LABEL[provider] ?? provider) : 'Canal'
  return name ? `${kind} · ${name}` : kind
}

function fmtWhen(v: unknown): string {
  const d = typeof v === 'string' ? new Date(v) : null
  if (!d || Number.isNaN(d.getTime())) return 'amanhã'
  try {
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return String(v)
  }
}

function describeEffect(args: {
  action: OrchAction
  payload: Record<string, unknown>
  dealTitle: string | null
  dealValue: number
  contactEmail: string | null
  proposal: { id: string; acceptedAt: string | null } | null
  items: number
}): { effect: string; warnings: string[]; proposalUrl: string | null } {
  const p = args.payload
  const deal = args.dealTitle ? `"${args.dealTitle}"` : 'o negócio'
  const warnings: string[] = []
  switch (args.action) {
    case 'collect_charges':
      return { effect: 'Envia a cobrança abaixo ao devedor, com as parcelas vencidas e o link de pagamento. Confira o valor antes de aprovar — depois de entregue não dá para desfazer.', warnings, proposalUrl: null }
    case 'send_followup':
    case 'reactivation':
      return { effect: 'Envia a mensagem abaixo pela conversa do contato no canal indicado — edite o texto e, se ele tiver mais de um canal, escolha por onde sai.', warnings, proposalUrl: null }
    case 'send_proposal': {
      if (!args.proposal) warnings.push('Não há proposta salva neste negócio. Abra o negócio → aba Propostas, salve a proposta e depois aprove aqui.')
      if (args.items === 0) warnings.push('A aba Produtos do negócio está vazia — o e-mail sairia sem itens (o envio falha).')
      if (!args.contactEmail) warnings.push('O contato não tem e-mail cadastrado — o envio falha. Cadastre o e-mail no contato ou recuse e mande a proposta pelo WhatsApp.')
      return {
        effect: `Envia por e-mail${args.contactEmail ? ` para ${args.contactEmail}` : ''} a proposta salva de ${deal}: itens da aba Produtos, totais e o link público da proposta (com aceite). A Fluxia NÃO escreve a proposta — ela manda a que estiver salva no negócio.`,
        warnings,
        proposalUrl: args.proposal ? `/proposta/${args.proposal.id}` : null,
      }
    }
    case 'draft_proposal': {
      if (args.proposal) {
        return { effect: `${deal} já tem proposta salva — nada a montar. Use "Enviar proposta".`, warnings, proposalUrl: `/proposta/${args.proposal.id}` }
      }
      if (args.items > 0) {
        return { effect: `Monta a proposta de ${deal} com os ${args.items} item(ns) já lançados na aba Produtos. Nada sai pro cliente — depois você revisa e envia.`, warnings, proposalUrl: null }
      }
      const v = Number(args.dealValue) || 0
      if (!v) {
        warnings.push('O negócio não tem produtos nem valor. Defina o valor do negócio (ou lance os itens na aba Produtos) — senão a proposta nasceria zerada.')
      }
      return {
        effect: v
          ? `Monta a proposta de ${deal} com 1 item ("${args.dealTitle ?? 'Serviço'}") no valor abaixo. Nada sai pro cliente — depois você revisa e envia.`
          : `Não dá pra montar: ${deal} está sem produtos e sem valor.`,
        warnings,
        proposalUrl: null,
      }
    }

    case 'apply_discount':
      return { effect: `Aplica ${Number(p.discountPct) || 0}% de desconto na proposta salva de ${deal} (só salva — não envia nada ao cliente).`, warnings, proposalUrl: args.proposal ? `/proposta/${args.proposal.id}` : null }
    case 'close_deal':
      return { effect: `Marca ${deal} como ${p.status === 'won' ? 'GANHO' : 'PERDIDO'}${typeof p.reason === 'string' && p.reason ? ` (motivo: ${p.reason})` : ''} e dispara as automações de ganho/perda da conta.`, warnings, proposalUrl: null }
    case 'move_deal': {
      const stage = typeof p.stageName === 'string' && p.stageName ? `"${p.stageName}"` : p.direction === 'next' ? 'seguinte' : 'indicada'
      return { effect: `Move ${deal} para a etapa ${stage} e cria as tarefas automáticas dessa etapa.`, warnings, proposalUrl: null }
    }
    case 'create_task':
      return { effect: `Cria a tarefa "${typeof p.title === 'string' && p.title ? p.title : 'Falar com o cliente'}" para o responsável de ${deal}, com prazo ${fmtWhen(p.dueAt)}.`, warnings, proposalUrl: null }
    case 'update_follow_up':
      return { effect: `Marca o próximo follow-up de ${deal} para ${fmtWhen(p.at)}.`, warnings, proposalUrl: null }
    case 'notify_seller':
      return { effect: 'Manda uma notificação no CRM para o responsável do negócio com o motivo acima. Nada vai para o cliente.', warnings, proposalUrl: null }
    case 'notify_owner':
      return { effect: 'Manda uma notificação no CRM para os administradores da conta. Nada vai para o cliente.', warnings, proposalUrl: null }
    case 'escalate':
      return { effect: 'Desliga a IA nesta conversa e avisa o time para assumir. Nada vai para o cliente.', warnings, proposalUrl: null }
    case 'start_cadence':
      return { effect: `Coloca o contato na cadência ${typeof p.cadenceName === 'string' && p.cadenceName ? `"${p.cadenceName}"` : 'escolhida'} (as mensagens da cadência passam a sair nos horários dela).`, warnings, proposalUrl: null }
    case 'pause_cadence':
      return { effect: 'Pausa a cadência ativa do contato (nenhuma mensagem sai).', warnings, proposalUrl: null }
    default:
      return { effect: 'Executa a ação indicada.', warnings, proposalUrl: null }
  }
}

/** Motivos prontos (o mesmo código agrupa decisões parecidas). */
export async function listReasonCodes(): Promise<{ code: string; label: string }[]> {
  return REASON_CODES
}

export interface AiBrake {
  mode: 'on' | 'suggest' | 'off'
  by: string | null
  at: string | null
  reason: string | null
  canChange: boolean
}

/** 🛑 Estado do freio da conta (topo da tela). */
export async function getAiBrake(): Promise<AiBrake> {
  const ctx = await getCurrentAccount()
  const s = await getAccountSettings(ctx.accountId)
  const mode = s.aiMode ?? (s.autonomyPaused ? 'off' : 'on')
  let byName: string | null = null
  if (s.aiModeBy) {
    const u = firstOrNull(await db.select({ name: user.name }).from(user).where(eq(user.id, s.aiModeBy)).limit(1))
    byName = u?.name ?? null
  }
  return { mode, by: byName, at: s.aiModeAt ?? null, reason: s.aiModeReason ?? null, canChange: hasMinRole(ctx.role, 'admin') }
}

/** Muda o freio (admin+). Registra quem mudou e por quê. */
export async function setAiBrake(mode: 'on' | 'suggest' | 'off', reason?: string): Promise<ActionResult> {
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, 'admin')) return { ok: false, error: 'Só administradores mudam o estado da IA.' }
  if (!['on', 'suggest', 'off'].includes(mode)) return { ok: false, error: 'Estado inválido.' }
  await updateAccountSettings(ctx.accountId, {
    aiMode: mode,
    autonomyPaused: mode === 'off', // mantém o campo legado coerente
    aiModeBy: ctx.userId,
    aiModeAt: new Date().toISOString(),
    aiModeReason: (reason ?? '').trim().slice(0, 300) || null,
  })
  revalidatePath('/aprovacoes')
  return { ok: true }
}
