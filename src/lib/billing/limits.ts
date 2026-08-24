// ============================================================
// 💳 Limites por plano — o enforcement do plano de entrada (Start R$139,90).
//
// Regra de ouro: NUNCA travar cliente existente. Só o Start tem limites;
// essencial/pro/enterprise (e contas sem plano) seguem ilimitados até o Alex
// definir cortes pra eles. O gate roda nos FUNIS de criação (canal, convite
// de atendente, agente IA) — quem já passou do limite antes de existir o
// gate não perde nada, só não cria MAIS.
// Sem 'server-only' (rotas + libs de canal alcançáveis por vários caminhos).
// ============================================================

import { and, eq, isNull } from 'drizzle-orm'

import { db, channels, member, aiConfigs, organizationBilling } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { PLANS, isPlanKey } from './plans'

export interface PlanLimits {
  /** null = ilimitado. */
  members: number | null
  channels: number | null
  aiAgents: number | null
  calling: boolean
}

const UNLIMITED: PlanLimits = {
  members: null,
  channels: null,
  aiAgents: null,
  calling: true,
}

/** Limites por plano. Start = porta de entrada enxuta; o resto ilimitado. */
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  start: { members: 1, channels: 1, aiAgents: 1, calling: false },
}

export type LimitResource = 'members' | 'channels' | 'aiAgents'

const RESOURCE_LABEL: Record<LimitResource, { singular: string; plural: string }> = {
  members: { singular: 'atendente', plural: 'atendentes' },
  channels: { singular: 'canal', plural: 'canais' },
  aiAgents: { singular: 'agente de IA', plural: 'agentes de IA' },
}

/** Erro amigável de limite — a message é segura pra mostrar ao usuário. */
export class PlanLimitError extends Error {
  readonly status = 403
  constructor(
    readonly resource: LimitResource,
    readonly limit: number,
    readonly planName: string,
  ) {
    const label = RESOURCE_LABEL[resource]
    super(
      `O plano ${planName} inclui ${limit} ${limit === 1 ? label.singular : label.plural}. ` +
        `Faça upgrade em Configurações → Assinatura para adicionar mais.`,
    )
    this.name = 'PlanLimitError'
  }
}

/** Limites do plano da conta (billing vivo; sem plano/desconhecido = ilimitado). */
export async function getAccountPlanLimits(
  accountId: string,
): Promise<{ limits: PlanLimits; planName: string }> {
  const row = firstOrNull(
    await db
      .select({ plan: organizationBilling.plan })
      .from(organizationBilling)
      .where(
        and(
          eq(organizationBilling.organizationId, accountId),
          isNull(organizationBilling.deletedAt),
        ),
      )
      .limit(1),
  )
  const plan = row?.plan ?? null
  const limits = (plan && PLAN_LIMITS[plan]) || UNLIMITED
  const planName = plan && isPlanKey(plan) ? PLANS[plan].name : plan ?? '—'
  return { limits, planName }
}

async function currentCount(
  accountId: string,
  resource: LimitResource,
): Promise<number> {
  if (resource === 'members') {
    const rows = await db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.organizationId, accountId))
    return rows.length
  }
  if (resource === 'channels') {
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.accountId, accountId))
    return rows.length
  }
  const rows = await db
    .select({ id: aiConfigs.id })
    .from(aiConfigs)
    .where(eq(aiConfigs.accountId, accountId))
  return rows.length
}

/**
 * Lança PlanLimitError se criar +1 `resource` estourar o limite do plano.
 * Chamar nos funis de criação ANTES do insert. Best-effort na leitura do
 * billing: erro de infra não bloqueia o cliente (fail-open), limite estourado
 * bloqueia com mensagem amigável (fail-closed no que importa).
 */
export async function assertPlanLimit(
  accountId: string,
  resource: LimitResource,
): Promise<void> {
  let limits: PlanLimits
  let planName: string
  try {
    ;({ limits, planName } = await getAccountPlanLimits(accountId))
  } catch {
    return // infra falhou — não travar o cliente por causa do gate
  }
  const limit = limits[resource]
  if (limit === null) return
  const current = await currentCount(accountId, resource)
  if (current >= limit) throw new PlanLimitError(resource, limit, planName)
}
