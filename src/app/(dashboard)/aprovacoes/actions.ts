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

import { db, agentActionRequests, contacts, customerSignals, deals, pipelineStages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { executeOrchestrationAction, noteDealEvent } from '@/lib/orchestration/actions'
import { ACTION_CATALOG, type OrchAction, type Risk } from '@/lib/orchestration/policy'
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

  return rows
    .filter((r) => isOrchAction(r.actionType))
    .map((r) => {
      const meta = ACTION_CATALOG[r.actionType as OrchAction]
      return {
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
export async function approveQueueItem(input: { id: string; text?: string | null; payload?: Record<string, unknown> }): Promise<ActionResult> {
  const ctx = await getCurrentAccount()
  if (ctx.role === 'viewer') return { ok: false, error: 'Seu papel só permite visualizar.' }
  const row = await loadPending(ctx.accountId, input.id)
  if (!row) return { ok: false, error: 'Este pedido não está mais pendente.' }
  if (!isOrchAction(row.actionType)) return { ok: false, error: 'Tipo de ação desconhecido.' }
  const action = row.actionType
  const meta = ACTION_CATALOG[action]
  const payload = { ...((row.payload ?? {}) as Record<string, unknown>), ...(input.payload ?? {}) }
  const text = meta.kind === 'message' ? (input.text ?? row.suggestedText ?? '').trim() : null
  if (meta.kind === 'message' && !text) return { ok: false, error: 'Escreva a mensagem antes de aprovar.' }

  let result: Record<string, unknown> = {}
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
      conversationId: row.conversationId,
      text,
      reason: row.reason ?? meta.label,
      payload,
    })
    if (!r.ok) error = r.error ?? 'Não deu certo.'
    else result = r.result ?? {}
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
      error: null,
    })
    .where(eq(agentActionRequests.id, row.id))
  if (row.signalId) {
    await db.update(customerSignals).set({ resolvedAt: now, updatedAt: now }).where(and(eq(customerSignals.id, row.signalId), isNull(customerSignals.resolvedAt)))
  }
  if (row.dealId) {
    await noteDealEvent(ctx.accountId, row.dealId, ctx.userId, `✅ ${meta.label} aprovado e executado. Por quê: ${row.reason ?? '—'}`)
  }
  revalidatePath('/aprovacoes')
  return { ok: true }
}

export async function rejectQueueItem(id: string, note?: string): Promise<ActionResult> {
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
  revalidatePath('/aprovacoes')
  return { ok: true }
}

/** Histórico recente (executadas/bloqueadas/recusadas) pra auditoria na mesma tela. */
export interface AuditItem {
  id: string
  action: OrchAction
  actionLabel: string
  status: string
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
    .map((r) => ({
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
    }))
}
