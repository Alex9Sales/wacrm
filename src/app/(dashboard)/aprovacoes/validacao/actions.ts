'use server'

// ============================================================
// 📊 Validação da autonomia — a IA ganha o direito de agir sozinha por
// EVIDÊNCIA, e esta tela mostra o placar: o que executou, o que precisou de
// gente, o que foi corrigido ou revertido e, por ação, quanto falta para
// soltar o automático. A leitura mora em lib/orchestration/validation-data.ts
// (sem sessão, exercitável por script); aqui fica só conta/papel e as
// escritas. Critério configurável por conta em ai_configs.autonomy.promotion
// (do agente padrão, como a política).
// Erros esperados voltam como { ok:false, error } (throw vira "digest" em prod).
// ============================================================

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { db, aiConfigs } from '@/db'
import { getCurrentAccount } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { ACTION_CATALOG, type Level } from '@/lib/orchestration/policy'
import { sanitizePromotionOverride } from '@/lib/orchestration/validation'
import { actionVerdict, isOrchAction, loadAutonomyValidation, loadDefaultAgent, type AutonomyValidation, type ValidationFilters } from '@/lib/orchestration/validation-data'

export type { ActionValidationRow, AutonomyValidation, Period, ValidationAuditItem, ValidationCards, ValidationFilters } from '@/lib/orchestration/validation-data'

export type ActionResult = { ok: true } | { ok: false; error: string }

/** O painel inteiro, com os filtros de período e ação (cards e auditoria); a tabela por ação é cumulativa. */
export async function getAutonomyValidation(input?: Partial<ValidationFilters>): Promise<AutonomyValidation> {
  const ctx = await getCurrentAccount()
  return loadAutonomyValidation(ctx.accountId, hasMinRole(ctx.role, 'admin'), input)
}

/**
 * Muda o nível de uma ação a partir do painel. Subir para AUTOMÁTICO passa
 * pelo portão de evidência (recusa sem histórico); descer é sempre imediato —
 * recolher autonomia nunca pode ter atrito.
 */
export async function promoteAction(actionInput: string, level: Level): Promise<ActionResult> {
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, 'admin')) return { ok: false, error: 'Só administradores mudam a autonomia das ações.' }
  if (!isOrchAction(actionInput)) return { ok: false, error: 'Ação desconhecida.' }
  if (level !== 'suggest' && level !== 'approve' && level !== 'auto') return { ok: false, error: 'Nível inválido.' }
  const action = actionInput
  const meta = ACTION_CATALOG[action]

  const agent = await loadDefaultAgent(ctx.accountId)
  if (!agent) return { ok: false, error: 'Nenhum agente padrão configurado nesta conta. Crie um em Agentes IA.' }

  if (level === 'auto') {
    if (meta.humanOnly) return { ok: false, error: `"${meta.label}" só o humano executa — nunca roda sozinha.` }
    if (meta.risk === 'critical') return { ok: false, error: `"${meta.label}" é crítica — sempre exige aprovação.` }
    const verdict = await actionVerdict(ctx.accountId, action, agent.autonomy)
    if (!verdict.ready) {
      return { ok: false, error: verdict.blockers[0]?.label ?? 'Esta ação ainda não tem histórico para operar sozinha.' }
    }
  }

  const current = (agent.autonomy && typeof agent.autonomy === 'object' ? agent.autonomy : {}) as Record<string, unknown>
  const actions = { ...((current.actions as Record<string, string> | undefined) ?? {}), [action]: level }
  const next: Record<string, unknown> = { ...current, actions }
  // Espelha no legado pra telas antigas de "Chamar de volta" continuarem certas.
  if (action === 'reactivation') next.reactivation = level
  await db.update(aiConfigs).set({ autonomy: next }).where(eq(aiConfigs.id, agent.id))

  revalidatePath('/aprovacoes/validacao')
  revalidatePath('/aprovacoes')
  if (action === 'collect_charges') revalidatePath('/cobrancas')
  return { ok: true }
}

/**
 * Critério da conta para liberar o automático (vale para todas as ações;
 * cobrança e dinheiro seguem com zero reversão). `null` volta ao padrão por tipo.
 */
export async function saveValidationCriteria(input: Record<string, unknown> | null): Promise<ActionResult> {
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, 'admin')) return { ok: false, error: 'Só administradores mudam o critério.' }
  const agent = await loadDefaultAgent(ctx.accountId)
  if (!agent) return { ok: false, error: 'Nenhum agente padrão configurado nesta conta. Crie um em Agentes IA.' }

  const clean = input ? sanitizePromotionOverride(input) : null
  if (input && !clean) return { ok: false, error: 'Nenhum valor válido. Use números: decisões (1–500), dias (0–365), taxas em % (0–100), reversões toleradas (0–50).' }

  const current = (agent.autonomy && typeof agent.autonomy === 'object' ? agent.autonomy : {}) as Record<string, unknown>
  const next: Record<string, unknown> = { ...current }
  if (clean) next.promotion = clean
  else delete next.promotion
  await db.update(aiConfigs).set({ autonomy: next }).where(eq(aiConfigs.id, agent.id))

  revalidatePath('/aprovacoes/validacao')
  revalidatePath('/cobrancas')
  return { ok: true }
}
