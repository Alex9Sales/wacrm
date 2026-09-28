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
 * O que vai ser COBRADO de uma vez, a partir do valor negociado por mês.
 *
 * 28/09. Diferente de `contractTotal` num ponto que custa dinheiro: aqui NÃO
 * entra o desconto de tabela. O valor que chega já é o negociado — a Appia
 * fechou R$ 130/mês sem o −20% do semestral, porque a venda saiu por uma
 * revendedora — e aplicar o desconto de novo cobraria menos do que o combinado.
 * `contractTotal` serve para simular a tabela; esta serve para emitir.
 *
 * A regra do contrato longo, do Alex: "assinatura semestral é sempre o valor
 * total dos 6 meses; ele parcela no cartão dele, mas nós recebemos o valor
 * integral. Mesma coisa seria se fosse anual." Mensal cobra um mês e repete;
 * semestral e anual cobram o contrato inteiro uma vez só.
 *
 * ⚠️ Existe para ser a ÚNICA fonte desse número. A tela do /admin mostra o total
 * antes do clique e a rota manda ao Asaas; com a conta escrita em dois lugares,
 * um dia a tela mostra R$ 780 e a cobrança sai R$ 4.680, e não tem desfazer.
 */
export function chargeForCycle(
  negotiatedMonthly: number,
  cycle: BillingCycle,
): { months: number; monthly: number; total: number; oneOff: boolean } {
  const months = CYCLES[cycle].months
  const monthly = Number.isFinite(negotiatedMonthly) && negotiatedMonthly > 0
    ? negotiatedMonthly
    : 0
  // Arredonda ao centavo: 130,50 × 6 em ponto flutuante dá 782,9999999999999,
  // e centavo a mais ou a menos numa cobrança é divergência com o cliente.
  const total = Math.round(monthly * months * 100) / 100
  return { months, monthly, total, oneOff: months > 1 }
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
