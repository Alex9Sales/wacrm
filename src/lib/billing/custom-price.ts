// ============================================================
// "Este cliente paga um valor NEGOCIADO, não o de tabela."
//
// 26/09: uma revendedora (Ação Comercial) fechou o Fluxia para um cliente
// dela a R$ 139,90 no semestral — valor que o Rafael prometeu por engano e o
// Alex decidiu honrar. O Start de tabela vai para R$ 297 em dezembro.
//
// Sem marcar isso, a lista do /admin fica mentindo: mostra "Start" na coluna
// do plano, e o Start custa 297 — mas aquele cliente paga 139,90. Quem abre o
// painel não tem como saber se é desconto combinado ou erro de cadastro.
//
// A regra é: `organization_billing.monthly_value` preenchido = o dono digitou
// um valor de propósito, e é ELE que vale (o MRR do painel já funciona assim,
// ver lib/admin/success.ts). Aqui só damos nome ao que já acontece.
// ============================================================

import { planPriceOf } from './plans'

/** Centavo de folga: 139.9 e 139.90 são o mesmo preço. */
const TOLERANCIA = 0.005

export interface PriceLabel {
  /** Quanto o cliente paga por mês, de fato. 0 = não dá pra saber. */
  price: number
  /** O dono digitou um valor em vez de usar a tabela? */
  custom: boolean
  /** Difere do preço de tabela do plano? (custom que COINCIDE não difere.) */
  differs: boolean
  /** Preço de tabela do plano, pra mostrar o "de/por". 0 = plano sem preço. */
  listPrice: number
}

/**
 * O que este cliente paga e se é valor negociado.
 *
 * ⚠️ `custom` e `differs` são coisas diferentes, de propósito. Um valor
 * digitado que hoje COINCIDE com a tabela continua sendo negociado: quando a
 * tabela subir (Start 139,90 → 297 em dezembro), esse cliente fica no valor
 * dele. É justamente o caso que motivou isto — e marcar só quem difere hoje
 * faria o cliente sumir da lista de negociados até a tabela mudar.
 */
export function priceLabelFor(
  plan: string | null | undefined,
  monthlyValue: number | null | undefined,
): PriceLabel {
  const listPrice = planPriceOf(plan ?? null)
  const raw = monthlyValue === null || monthlyValue === undefined ? NaN : Number(monthlyValue)
  const custom = Number.isFinite(raw) && raw > 0
  const price = custom ? raw : listPrice
  return {
    price,
    custom,
    differs: custom && Math.abs(raw - listPrice) > TOLERANCIA,
    listPrice,
  }
}
