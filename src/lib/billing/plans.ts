// ============================================================
// Planos do FluxiaCRM — fonte única (bate com o site de vendas, src/app/page.tsx).
// Preço mensal em BRL. Usado no checkout (Asaas) e na UI de assinatura.
// ============================================================

export type PlanKey = 'essencial' | 'pro' | 'enterprise'

export interface Plan {
  key: PlanKey
  /** Nome exibido (também gravado em organization_billing.plan). */
  name: string
  /** Preço mensal em reais. */
  price: number
  /** Ciclo de cobrança do Asaas. */
  cycle: 'MONTHLY'
  tagline: string
}

export const PLANS: Record<PlanKey, Plan> = {
  essencial: {
    key: 'essencial',
    name: 'Essencial',
    price: 497,
    cycle: 'MONTHLY',
    tagline: 'O atendimento e o funil organizados',
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    price: 799,
    cycle: 'MONTHLY',
    tagline: 'Vendas no automático, com Inteligência Artificial',
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    price: 1999,
    cycle: 'MONTHLY',
    tagline: 'Voz, ligação e escala com prioridade',
  },
}

/** Lista ordenada (pra render de cards). */
export const PLAN_LIST: Plan[] = [PLANS.essencial, PLANS.pro, PLANS.enterprise]

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLANS, v)
}

export function getPlan(key: string): Plan | null {
  return isPlanKey(key) ? PLANS[key] : null
}

/** Formata o preço em reais (ex.: 1999 → "R$ 1.999"). */
export function formatPrice(value: number): string {
  return `R$ ${value.toLocaleString('pt-BR')}`
}
