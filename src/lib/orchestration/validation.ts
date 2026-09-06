// ============================================================
// 📊 Validação da autonomia — a parte PURA (client-safe, testada).
//
// Princípio (03/09, invariante da conta): a IA só ganha o direito de agir
// sozinha por EVIDÊNCIA medida — decisões humanas registradas em
// `decision_feedback` (aprovou / editou / recusou / reverteu). Aqui mora:
//   - o critério de promoção por TIPO de ação (mensagem é mais duro que CRM;
//     dinheiro e cobrança nunca toleram reversão) + o override da conta;
//   - a conversão do histórico em PromotionStats;
//   - o status que a tela mostra por ação (Em validação / Quase pronta /
//     Elegível / Automática / Só humano / Só sugere).
// Quem lê o banco é aprovacoes/validacao/actions.ts.
// ============================================================

import { COLLECTION_PROMOTION, type PromotionCriteria, type PromotionStats, type PromotionVerdict } from '@/lib/collections/promotion'

import { ACTION_CATALOG, type ActionMeta, type Level, type OrchAction } from './policy'

/** Critério padrão por tipo de ação. Mensagem fala com o cliente: mais duro que mexer no CRM. */
export const DEFAULT_CRITERIA: Record<ActionMeta['kind'], PromotionCriteria> = {
  message: { minDecisions: 20, minDays: 14, minCleanApprovalRate: 0.85, maxRejectionRate: 0.1, maxBadOutcomes: 0 },
  money: { minDecisions: 20, minDays: 14, minCleanApprovalRate: 0.9, maxRejectionRate: 0.05, maxBadOutcomes: 0 },
  crm: { minDecisions: 10, minDays: 7, minCleanApprovalRate: 0.9, maxRejectionRate: 0.1, maxBadOutcomes: 0 },
  notify: { minDecisions: 10, minDays: 7, minCleanApprovalRate: 0.8, maxRejectionRate: 0.2, maxBadOutcomes: 0 },
}

/** Override da conta (ai_configs.autonomy.promotion): só as chaves que a pessoa mexeu. */
export type PromotionOverride = Partial<PromotionCriteria>

const CRITERIA_KEYS: (keyof PromotionCriteria)[] = ['minDecisions', 'minDays', 'minCleanApprovalRate', 'maxRejectionRate', 'maxBadOutcomes']

/**
 * Limpa o que vem do formulário / do jsonb. Devolve null quando não sobra nada
 * válido — aí a conta segue no padrão por tipo. Taxas em fração 0..1.
 */
export function sanitizePromotionOverride(input: unknown): PromotionOverride | null {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
  if (!o) return null
  const out: PromotionOverride = {}
  const md = Number(o.minDecisions)
  if (Number.isInteger(md) && md >= 1 && md <= 500) out.minDecisions = md
  const dd = Number(o.minDays)
  if (Number.isInteger(dd) && dd >= 0 && dd <= 365) out.minDays = dd
  const cr = Number(o.minCleanApprovalRate)
  if (Number.isFinite(cr) && cr >= 0 && cr <= 1) out.minCleanApprovalRate = cr
  const rr = Number(o.maxRejectionRate)
  if (Number.isFinite(rr) && rr >= 0 && rr <= 1) out.maxRejectionRate = rr
  const bo = Number(o.maxBadOutcomes)
  if (Number.isInteger(bo) && bo >= 0 && bo <= 50) out.maxBadOutcomes = bo
  return Object.keys(out).length ? out : null
}

/** Lê o override guardado no jsonb `ai_configs.autonomy` (tolerante a lixo). */
export function readPromotionOverride(autonomy: unknown): PromotionOverride | null {
  const a = autonomy && typeof autonomy === 'object' ? (autonomy as Record<string, unknown>) : null
  return sanitizePromotionOverride(a?.promotion)
}

/**
 * Critério efetivo da ação: padrão do tipo (cobrança tem o dela, mais duro),
 * coberto pelo override da conta. Dinheiro e cobrança NUNCA toleram reversão:
 * cobrar quem já pagou não tem desfazer — é condição, não configuração.
 */
export function criteriaFor(action: OrchAction, override?: PromotionOverride | null): PromotionCriteria {
  const meta = ACTION_CATALOG[action]
  const base = action === 'collect_charges' ? COLLECTION_PROMOTION : DEFAULT_CRITERIA[meta.kind]
  const merged: PromotionCriteria = { ...base }
  if (override) {
    for (const k of CRITERIA_KEYS) {
      const v = override[k]
      if (typeof v === 'number' && Number.isFinite(v)) merged[k] = v
    }
  }
  if (action === 'collect_charges' || meta.kind === 'money') merged.maxBadOutcomes = 0
  return merged
}

/**
 * O portão vale para as ações que o produto NÃO confia por padrão (nascem em
 * "sugere" ou "aprova"). Avisos, tarefa, reagendar, pausar cadência e escalar
 * já nascem automáticas e são de baixo risco: ligam e desligam sem portão.
 * "Só humano" nunca vira auto — o portão nem se aplica.
 */
export function gateApplies(action: OrchAction): boolean {
  const meta = ACTION_CATALOG[action]
  return !meta.humanOnly && meta.defaultLevel !== 'auto'
}

export interface FeedbackCounts {
  approved: number
  edited: number
  rejected: number
  reversed: number
  badResult: number
  /** ISO da primeira e da última decisão (qualquer tipo). */
  first: string | null
  last: string | null
}

const DAY = 86_400_000

/**
 * Do histórico agregado para o que o portão avalia. "Decisões" = o humano
 * julgou uma PROPOSTA (aprovou, editou ou recusou). Reversão e resultado ruim
 * são um segundo julgamento sobre a mesma ação: contam como erro, não como
 * decisão — senão a mesma ação contaria duas vezes e diluiria as taxas.
 */
export function statsFromCounts(c: FeedbackCounts): PromotionStats {
  const first = c.first ? new Date(c.first).getTime() : 0
  const last = c.last ? new Date(c.last).getTime() : 0
  const span = first && last && last >= first ? Math.floor((last - first) / DAY) : 0
  return {
    decisions: c.approved + c.edited + c.rejected,
    cleanApprovals: c.approved,
    edited: c.edited,
    rejected: c.rejected,
    badOutcomes: c.reversed + c.badResult,
    spanDays: span,
  }
}

export interface FeedbackRow {
  decision: string
  createdAt: string
}

/** Linhas cruas de decision_feedback (uma ação) → PromotionStats. */
export function statsFromFeedback(rows: FeedbackRow[]): PromotionStats {
  const c: FeedbackCounts = { approved: 0, edited: 0, rejected: 0, reversed: 0, badResult: 0, first: null, last: null }
  for (const r of rows) {
    if (r.decision === 'approved') c.approved += 1
    else if (r.decision === 'edited') c.edited += 1
    else if (r.decision === 'rejected') c.rejected += 1
    else if (r.decision === 'reversed') c.reversed += 1
    else if (r.decision === 'bad_result') c.badResult += 1
    if (!c.first || r.createdAt < c.first) c.first = r.createdAt
    if (!c.last || r.createdAt > c.last) c.last = r.createdAt
  }
  return statsFromCounts(c)
}

export type ValidationStatus = 'suggest_only' | 'validating' | 'almost' | 'eligible' | 'auto' | 'human_only' | 'free'

/** A partir daqui a tela chama de "quase pronta". */
export const ALMOST_THRESHOLD = 0.6

export const VALIDATION_STATUS_META: Record<ValidationStatus, { label: string; hint: string; tone: 'muted' | 'amber' | 'emerald' | 'primary' | 'red' }> = {
  suggest_only: {
    label: 'Só sugere',
    hint: 'Nesta ação a IA só sugere e o humano inicia — não gera histórico. Passe para "pede aprovação" para começar a medir.',
    tone: 'muted',
  },
  validating: { label: 'Em validação', hint: 'Ainda reunindo decisões humanas para provar que a IA acerta.', tone: 'amber' },
  almost: { label: 'Quase pronta', hint: 'A maior parte do caminho já foi andada — falta pouco para liberar.', tone: 'primary' },
  eligible: { label: 'Elegível', hint: 'O histórico atende ao critério. Liberar o automático é decisão sua.', tone: 'emerald' },
  auto: { label: 'Automática', hint: 'Já opera sozinha dentro dos tetos. Reversões e correções seguem contando.', tone: 'emerald' },
  human_only: { label: 'Só humano', hint: 'Esta ação nunca roda sozinha — exige uma pessoa executar.', tone: 'red' },
  free: { label: 'Liberada', hint: 'Baixo risco e automática por padrão: liga e desliga sem portão.', tone: 'muted' },
}

export const LEVEL_LABEL: Record<Level, string> = {
  suggest: 'Só sugere',
  approve: 'Pede aprovação',
  auto: 'Automática',
}

/** Status que a tabela "por ação" mostra. Determinístico. `gated` = gateApplies(ação). */
export function validationStatus(args: { level: Level; humanOnly: boolean; verdict: PromotionVerdict; gated?: boolean }): ValidationStatus {
  if (args.humanOnly) return 'human_only'
  if (args.level === 'auto') return 'auto'
  if (args.gated === false) return 'free'
  if (args.verdict.ready) return 'eligible'
  if (args.level === 'suggest') return 'suggest_only'
  return args.verdict.progress >= ALMOST_THRESHOLD ? 'almost' : 'validating'
}

/** Taxa de confiança (0–100): aprovadas SEM edição ÷ decisões humanas. null sem amostra. */
export function confidenceRate(c: { approved: number; edited: number; rejected: number }): number | null {
  const n = c.approved + c.edited + c.rejected
  return n > 0 ? Math.round((c.approved / n) * 100) : null
}
