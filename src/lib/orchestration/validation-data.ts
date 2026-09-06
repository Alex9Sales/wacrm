// ============================================================
// 📊 Validação da autonomia — a parte que LÊ o banco (sem sessão).
//
// A Server Action (aprovacoes/validacao/actions.ts) resolve a conta e o papel
// e chama isto. Separado pra dar pra exercitar o SQL fora do app (script /
// worker) e pra manter a action fina. Lê o que já existe:
// agent_action_requests + decision_feedback (+ contatos, negócios, sinais,
// usuários pra auditoria). Não grava nada.
// ============================================================

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'

import { db, agentActionRequests, aiConfigs, contacts, customerSignals, deals, decisionFeedback, user } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { evaluatePromotion, type PromotionCriteria, type PromotionVerdict } from '@/lib/collections/promotion'

import { contextChips } from './context-chips'
import { ACTION_CATALOG, ORCH_ACTIONS, levelFor, readPolicy, type ActionMeta, type Level, type OrchAction, type Risk } from './policy'
import { REVERT_MATRIX, type RevertKind } from './revert'
import {
  confidenceRate,
  criteriaFor,
  gateApplies,
  readPromotionOverride,
  statsFromCounts,
  validationStatus,
  type FeedbackCounts,
  type PromotionOverride,
  type ValidationStatus,
} from './validation'

export type Period = 7 | 14 | 30 | 90
export const PERIODS: Period[] = [7, 14, 30, 90]

export interface ValidationFilters {
  days: Period
  action: OrchAction | 'all'
}

export interface ValidationCards {
  /** Ações executadas no período (automáticas + aprovadas). */
  executions: number
  autoExecutions: number
  approvedExecutions: number
  /** % das execuções que foram automáticas (null sem execução). */
  autoShare: number | null
  /** Correções: texto editado ANTES de enviar + ação corrigida DEPOIS (IA pausada na conversa). */
  edited: number
  corrected: number
  /** Desfeitas ou marcadas como resultado ruim. */
  reversed: number
  /** Foram para a fila humana (a política pediu aprovação). */
  escalated: number
  pendingNow: number
  blocked: number
  failed: number
  /** Decisões humanas no período (aprovou / editou / recusou). */
  humanDecisions: number
  cleanApprovals: number
  rejected: number
  /** 0–100: aprovadas sem editar ÷ decisões humanas (null sem amostra). */
  confidence: number | null
}

export interface ActionValidationRow {
  action: OrchAction
  label: string
  hint: string
  risk: Risk
  kind: ActionMeta['kind']
  humanOnly: boolean
  level: Level
  status: ValidationStatus
  /** Histórico COMPLETO da ação (o portão é cumulativo, não por período). */
  verdict: PromotionVerdict
  criteria: PromotionCriteria
  firstDecisionAt: string | null
  lastDecisionAt: string | null
  pending: number
  executedAll: number
  autoAll: number
  executedPeriod: number
  /** Revertidas, corrigidas ou marcadas como erradas (todo o histórico). */
  badOutcomesAll: number
}

export interface ValidationFeedback {
  decision: string
  reasonCode: string | null
  reasonText: string | null
  at: string
}

export interface ValidationAuditItem {
  id: string
  action: OrchAction
  actionLabel: string
  kind: ActionMeta['kind']
  risk: Risk
  status: string
  /** auto | approve | suggest | blocked (o que a política decidiu na hora). */
  decision: string | null
  /** A regra, em português, que decidiu. */
  policy: string | null
  /** Por que a IA quis agir (motivo do sinal/NBA). */
  reason: string | null
  signalType: string | null
  severity: number | null
  chips: string[]
  contactId: string
  contactName: string | null
  dealId: string | null
  dealTitle: string | null
  conversationId: string | null
  suggestedText: string | null
  byHuman: boolean
  resolvedByName: string | null
  createdAt: string
  resolvedAt: string | null
  executedAt: string | null
  outcome: string | null
  outcomeReason: string | null
  revertedAt: string | null
  revertKind: RevertKind
  error: string | null
  feedback: ValidationFeedback[]
}

export interface AutonomyValidation {
  days: Period
  since: string
  action: OrchAction | 'all'
  canManage: boolean
  hasDefaultAgent: boolean
  cards: ValidationCards
  actions: ActionValidationRow[]
  override: PromotionOverride | null
  audit: ValidationAuditItem[]
}

export function isOrchAction(v: unknown): v is OrchAction {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ACTION_CATALOG, v)
}

export function normalizeValidationFilters(input: Partial<ValidationFilters> | undefined): ValidationFilters {
  const days = PERIODS.includes(input?.days as Period) ? (input!.days as Period) : 30
  const action = isOrchAction(input?.action) ? input!.action : 'all'
  return { days, action }
}

/** O agente padrão guarda a política e o critério (mesmo desligado — política é configuração). */
export async function loadDefaultAgent(accountId: string): Promise<{ id: string; autonomy: unknown } | null> {
  return firstOrNull(
    await db
      .select({ id: aiConfigs.id, autonomy: aiConfigs.autonomy })
      .from(aiConfigs)
      .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
      .orderBy(desc(aiConfigs.isActive))
      .limit(1),
  )
}

const EMPTY_COUNTS = (): FeedbackCounts => ({ approved: 0, edited: 0, rejected: 0, reversed: 0, badResult: 0, first: null, last: null })

/** Histórico completo de decisões humanas, agregado por ação. */
export async function feedbackCountsByAction(accountId: string): Promise<Map<string, FeedbackCounts>> {
  const rows = await db
    .select({
      actionType: decisionFeedback.actionType,
      decision: decisionFeedback.decision,
      n: sql<number>`count(*)::int`,
      first: sql<string | null>`min(${decisionFeedback.createdAt})`,
      last: sql<string | null>`max(${decisionFeedback.createdAt})`,
    })
    .from(decisionFeedback)
    .where(eq(decisionFeedback.accountId, accountId))
    .groupBy(decisionFeedback.actionType, decisionFeedback.decision)
  const out = new Map<string, FeedbackCounts>()
  for (const r of rows) {
    const c = out.get(r.actionType) ?? EMPTY_COUNTS()
    if (r.decision === 'approved') c.approved += r.n
    else if (r.decision === 'edited') c.edited += r.n
    else if (r.decision === 'rejected') c.rejected += r.n
    else if (r.decision === 'reversed') c.reversed += r.n
    else if (r.decision === 'bad_result') c.badResult += r.n
    if (r.first && (!c.first || r.first < c.first)) c.first = r.first
    if (r.last && (!c.last || r.last > c.last)) c.last = r.last
    out.set(r.actionType, c)
  }
  return out
}

/** Veredito do portão para UMA ação (usado ao liberar o automático). */
export async function actionVerdict(accountId: string, action: OrchAction, autonomy: unknown): Promise<PromotionVerdict> {
  const counts = (await feedbackCountsByAction(accountId)).get(action) ?? EMPTY_COUNTS()
  return evaluatePromotion(statsFromCounts(counts), criteriaFor(action, readPromotionOverride(autonomy)))
}

/**
 * 🔒 O portão em UMA frase: pode subir esta ação para AUTOMÁTICO agora?
 * null = pode (não tem portão, ou o histórico atende ao critério da conta).
 * Senão devolve o motivo em português, pronto pra tela. Critério = o da
 * conta (override no agente padrão), igual ao painel — um portão só, em
 * todo lugar que promove (painel, matriz em Agentes IA, Cobranças).
 */
export async function promotionBlocker(accountId: string, action: OrchAction): Promise<string | null> {
  if (!gateApplies(action)) return null
  const agent = await loadDefaultAgent(accountId)
  const verdict = await actionVerdict(accountId, action, agent?.autonomy ?? null)
  if (verdict.ready) return null
  const why = verdict.blockers[0]?.label ?? 'ainda não há histórico suficiente.'
  return `"${ACTION_CATALOG[action].label}" ainda não pode rodar sozinha: ${why} Valide em Precisa de você → Validação da autonomia.`
}

export interface PromotionGate {
  gated: boolean
  eligible: boolean
  /** Motivo do bloqueio (só quando gated && !eligible). */
  blocker: string | null
}

/** O estado do portão de todas as ações (pra tela travar a célula "automático" antes de salvar). */
export async function loadPromotionGates(accountId: string): Promise<Record<OrchAction, PromotionGate>> {
  const [agent, counts] = await Promise.all([loadDefaultAgent(accountId), feedbackCountsByAction(accountId)])
  const override = readPromotionOverride(agent?.autonomy ?? null)
  const out = {} as Record<OrchAction, PromotionGate>
  for (const act of ORCH_ACTIONS) {
    if (!gateApplies(act)) {
      out[act] = { gated: false, eligible: true, blocker: null }
      continue
    }
    const verdict = evaluatePromotion(statsFromCounts(counts.get(act) ?? EMPTY_COUNTS()), criteriaFor(act, override))
    out[act] = { gated: true, eligible: verdict.ready, blocker: verdict.ready ? null : (verdict.blockers[0]?.label ?? 'Ainda não há histórico suficiente.') }
  }
  return out
}

/** O painel inteiro. Cards e auditoria seguem os filtros; a tabela por ação é cumulativa. */
export async function loadAutonomyValidation(accountId: string, canManage: boolean, input?: Partial<ValidationFilters>): Promise<AutonomyValidation> {
  const { days, action } = normalizeValidationFilters(input)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const decidedAt = sql`coalesce(${agentActionRequests.resolvedAt}, ${agentActionRequests.createdAt})`
  const reqActionFilter = action !== 'all' ? eq(agentActionRequests.actionType, action) : undefined
  const fbActionFilter = action !== 'all' ? eq(decisionFeedback.actionType, action) : undefined

  const [agent, req, fb, byAction, reqByAction] = await Promise.all([
    loadDefaultAgent(accountId),
    db
      .select({
        executions: sql<number>`count(*) filter (where ${agentActionRequests.status} in ('sent','done'))::int`,
        autoExecutions: sql<number>`count(*) filter (where ${agentActionRequests.status} in ('sent','done') and ${agentActionRequests.resolvedBy} is null)::int`,
        corrected: sql<number>`count(*) filter (where ${agentActionRequests.outcome} = 'corrected')::int`,
        reversed: sql<number>`count(*) filter (where ${agentActionRequests.outcome} in ('reverted','bad_result'))::int`,
        escalated: sql<number>`count(*) filter (where ${agentActionRequests.decision} = 'approve')::int`,
        pendingNow: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'pending')::int`,
        blocked: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'blocked')::int`,
        failed: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'failed')::int`,
      })
      .from(agentActionRequests)
      .where(and(eq(agentActionRequests.accountId, accountId), sql`${decidedAt} >= ${since}`, reqActionFilter)),
    db
      .select({
        approved: sql<number>`count(*) filter (where ${decisionFeedback.decision} = 'approved')::int`,
        edited: sql<number>`count(*) filter (where ${decisionFeedback.decision} = 'edited')::int`,
        rejected: sql<number>`count(*) filter (where ${decisionFeedback.decision} = 'rejected')::int`,
      })
      .from(decisionFeedback)
      .where(and(eq(decisionFeedback.accountId, accountId), sql`${decisionFeedback.createdAt} >= ${since}`, fbActionFilter)),
    feedbackCountsByAction(accountId),
    db
      .select({
        actionType: agentActionRequests.actionType,
        pending: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'pending')::int`,
        executedAll: sql<number>`count(*) filter (where ${agentActionRequests.status} in ('sent','done'))::int`,
        autoAll: sql<number>`count(*) filter (where ${agentActionRequests.status} in ('sent','done') and ${agentActionRequests.resolvedBy} is null)::int`,
        executedPeriod: sql<number>`count(*) filter (where ${agentActionRequests.status} in ('sent','done') and ${decidedAt} >= ${since})::int`,
        badOutcomesAll: sql<number>`count(*) filter (where ${agentActionRequests.outcome} in ('reverted','corrected','bad_result'))::int`,
      })
      .from(agentActionRequests)
      .where(eq(agentActionRequests.accountId, accountId))
      .groupBy(agentActionRequests.actionType),
  ])

  const r = req[0]
  const f = fb[0]
  const approved = f?.approved ?? 0
  const edited = f?.edited ?? 0
  const rejected = f?.rejected ?? 0
  const executions = r?.executions ?? 0
  const autoExecutions = r?.autoExecutions ?? 0
  const cards: ValidationCards = {
    executions,
    autoExecutions,
    approvedExecutions: executions - autoExecutions,
    autoShare: executions > 0 ? Math.round((autoExecutions / executions) * 100) : null,
    edited,
    corrected: r?.corrected ?? 0,
    reversed: r?.reversed ?? 0,
    escalated: r?.escalated ?? 0,
    pendingNow: r?.pendingNow ?? 0,
    blocked: r?.blocked ?? 0,
    failed: r?.failed ?? 0,
    humanDecisions: approved + edited + rejected,
    cleanApprovals: approved,
    rejected,
    confidence: confidenceRate({ approved, edited, rejected }),
  }

  const policy = readPolicy(agent?.autonomy ?? null)
  const override = readPromotionOverride(agent?.autonomy ?? null)
  const reqMap = new Map(reqByAction.map((x) => [x.actionType, x]))
  const actions: ActionValidationRow[] = ORCH_ACTIONS.map((act) => {
    const meta = ACTION_CATALOG[act]
    const counts = byAction.get(act) ?? EMPTY_COUNTS()
    const criteria = criteriaFor(act, override)
    const verdict = evaluatePromotion(statsFromCounts(counts), criteria)
    const level = levelFor(policy, act)
    const rq = reqMap.get(act)
    return {
      action: act,
      label: meta.label,
      hint: meta.hint,
      risk: meta.risk,
      kind: meta.kind,
      humanOnly: !!meta.humanOnly,
      level,
      status: validationStatus({ level, humanOnly: !!meta.humanOnly, verdict, gated: gateApplies(act) }),
      verdict,
      criteria,
      firstDecisionAt: counts.first,
      lastDecisionAt: counts.last,
      pending: rq?.pending ?? 0,
      executedAll: rq?.executedAll ?? 0,
      autoAll: rq?.autoAll ?? 0,
      executedPeriod: rq?.executedPeriod ?? 0,
      badOutcomesAll: rq?.badOutcomesAll ?? 0,
    }
  })

  const audit = await listValidationAudit(accountId, since, action)

  return { days, since, action, canManage, hasDefaultAgent: !!agent, cards, actions, override, audit }
}

/** Auditoria com a cadeia completa: sinal → política → decisão → ação → motivo → resultado. */
export async function listValidationAudit(accountId: string, since: string, action: OrchAction | 'all', limit = 100): Promise<ValidationAuditItem[]> {
  const decidedAt = sql`coalesce(${agentActionRequests.resolvedAt}, ${agentActionRequests.createdAt})`
  const rows = await db
    .select({
      id: agentActionRequests.id,
      actionType: agentActionRequests.actionType,
      status: agentActionRequests.status,
      decision: agentActionRequests.decision,
      policy: agentActionRequests.policy,
      reason: agentActionRequests.reason,
      payload: agentActionRequests.payload,
      suggestedText: agentActionRequests.suggestedText,
      contactId: agentActionRequests.contactId,
      dealId: agentActionRequests.dealId,
      conversationId: agentActionRequests.conversationId,
      resolvedBy: agentActionRequests.resolvedBy,
      createdAt: agentActionRequests.createdAt,
      resolvedAt: agentActionRequests.resolvedAt,
      executedAt: agentActionRequests.executedAt,
      outcome: agentActionRequests.outcome,
      outcomeReason: agentActionRequests.outcomeReason,
      revertedAt: agentActionRequests.revertedAt,
      error: agentActionRequests.error,
      contactName: contacts.name,
      dealTitle: deals.title,
      signalType: customerSignals.signalType,
      severity: customerSignals.severity,
      resolvedByName: user.name,
    })
    .from(agentActionRequests)
    .leftJoin(contacts, eq(contacts.id, agentActionRequests.contactId))
    .leftJoin(deals, eq(deals.id, agentActionRequests.dealId))
    .leftJoin(customerSignals, eq(customerSignals.id, agentActionRequests.signalId))
    .leftJoin(user, eq(user.id, agentActionRequests.resolvedBy))
    .where(
      and(
        eq(agentActionRequests.accountId, accountId),
        ne(agentActionRequests.status, 'pending'),
        sql`${decidedAt} >= ${since}`,
        action !== 'all' ? eq(agentActionRequests.actionType, action) : undefined,
      ),
    )
    .orderBy(desc(decidedAt))
    .limit(Math.max(1, Math.min(200, limit)))

  const ids = rows.map((x) => x.id)
  const fbByRequest = new Map<string, ValidationFeedback[]>()
  if (ids.length) {
    const fbs = await db
      .select({
        requestId: decisionFeedback.requestId,
        decision: decisionFeedback.decision,
        reasonCode: decisionFeedback.reasonCode,
        reasonText: decisionFeedback.reasonText,
        at: decisionFeedback.createdAt,
      })
      .from(decisionFeedback)
      .where(and(eq(decisionFeedback.accountId, accountId), inArray(decisionFeedback.requestId, ids)))
      .orderBy(decisionFeedback.createdAt)
    for (const x of fbs) {
      if (!x.requestId) continue
      const list = fbByRequest.get(x.requestId) ?? []
      list.push({ decision: x.decision, reasonCode: x.reasonCode, reasonText: x.reasonText, at: x.at })
      fbByRequest.set(x.requestId, list)
    }
  }

  return rows
    .filter((x) => isOrchAction(x.actionType))
    .map((x) => {
      const act = x.actionType as OrchAction
      const meta = ACTION_CATALOG[act]
      const payload = (x.payload ?? {}) as Record<string, unknown>
      return {
        id: x.id,
        action: act,
        actionLabel: meta.label,
        kind: meta.kind,
        risk: meta.risk,
        status: x.status,
        decision: x.decision,
        policy: x.policy,
        reason: x.reason,
        signalType: x.signalType ?? (typeof payload.signalType === 'string' ? payload.signalType : null),
        severity: x.severity ?? (typeof payload.severity === 'number' ? payload.severity : null),
        chips: contextChips(payload),
        contactId: x.contactId,
        contactName: x.contactName ?? null,
        dealId: x.dealId,
        dealTitle: x.dealTitle ?? null,
        conversationId: x.conversationId,
        suggestedText: meta.kind === 'message' ? x.suggestedText : null,
        byHuman: !!x.resolvedBy,
        resolvedByName: x.resolvedByName ?? null,
        createdAt: x.createdAt,
        resolvedAt: x.resolvedAt,
        executedAt: x.executedAt,
        outcome: x.outcome,
        outcomeReason: x.outcomeReason,
        revertedAt: x.revertedAt,
        revertKind: REVERT_MATRIX[act].kind,
        error: x.error,
        feedback: fbByRequest.get(x.id) ?? [],
      }
    })
}
