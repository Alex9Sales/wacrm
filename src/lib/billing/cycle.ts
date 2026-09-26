// ============================================================
// Periodicidade do contrato — mensal, semestral, anual.
//
// 26/09: uma revendedora (Ação Comercial) fechou o Fluxia para um cliente dela
// em SEIS MESES e não havia onde registrar. Aprovado com o Rafael: mensal
// cheio, semestral −20%, anual −30%, valendo com os preços de dezembro
// (Start 297 · Growth 697 · Scale 1.297 · Enterprise 2.990+).
//
// ⚠️ A REGRA DE OURO DESTE ARQUIVO: tudo aqui fala em valor POR MÊS. O total
// do contrato é derivado (mês × meses), nunca o contrário. O MRR é mensal por
// definição; gravar o total do semestre como "valor" faria a receita
// recorrente inchar seis vezes no painel.
// ============================================================

export type BillingCycle = 'monthly' | 'semiannual' | 'annual'

export const BILLING_CYCLES: BillingCycle[] = ['monthly', 'semiannual', 'annual']

interface CycleInfo {
  label: string
  /** Quantos meses o cliente se compromete. */
  months: number
  /** Desconto sobre o preço cheio (0 = sem desconto). */
  discount: number
  short: string
}

export const CYCLES: Record<BillingCycle, CycleInfo> = {
  monthly: { label: 'Mensal', months: 1, discount: 0, short: 'mês' },
  semiannual: { label: 'Semestral', months: 6, discount: 0.2, short: '6 meses' },
  annual: { label: 'Anual', months: 12, discount: 0.3, short: '12 meses' },
}

export function isBillingCycle(v: unknown): v is BillingCycle {
  return typeof v === 'string' && (BILLING_CYCLES as string[]).includes(v)
}

/** Normaliza o que vem do banco/formulário. Desconhecido → null, nunca chute. */
export function parseBillingCycle(v: unknown): BillingCycle | null {
  return isBillingCycle(v) ? v : null
}

export function cycleLabel(v: unknown): string | null {
  const c = parseBillingCycle(v)
  return c ? CYCLES[c].label : null
}

/**
 * Preço POR MÊS de um ciclo, a partir do valor cheio (mensal).
 *
 * Arredonda para baixo, ao real: a tabela fechada com o Rafael tem valores
 * comerciais (237, 557, 1.037) e não centavos quebrados — 297 × 0,8 dá 237,60,
 * e o que vai pro cliente é 237.
 */
export function monthlyPriceForCycle(fullMonthly: number, cycle: BillingCycle): number {
  const v = Number(fullMonthly)
  if (!Number.isFinite(v) || v <= 0) return 0
  return Math.floor(v * (1 - CYCLES[cycle].discount))
}

/** O que o cliente paga de uma vez ao fechar o contrato. */
export function contractTotal(fullMonthly: number, cycle: BillingCycle): number {
  return monthlyPriceForCycle(fullMonthly, cycle) * CYCLES[cycle].months
}

/**
 * Quando vence a próxima cobrança do ciclo, a partir de uma data.
 *
 * Usa o mesmo dia do mês; quando o dia não existe no mês de destino (31 de
 * agosto + 6 meses = 31 de fevereiro), cai no último dia daquele mês em vez de
 * vazar para o mês seguinte — que é como o cliente lê um contrato.
 */
export function nextChargeDate(from: Date, cycle: BillingCycle): Date {
  const meses = CYCLES[cycle].months
  const dia = from.getDate()
  const d = new Date(from)
  d.setDate(1)
  d.setMonth(d.getMonth() + meses)
  const ultimoDia = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(dia, ultimoDia))
  return d
}
