// ============================================================
// Condições de pagamento do NEGÓCIO (pedido do Rafael, 08/09).
//
// No "Novo negócio" o valor é opcional, mas a equipe quer registrar COMO o
// cliente vai pagar: à vista ou recorrente, em quantas vezes, por qual meio.
// Isso vira selo no card, campo no detalhe e contexto pro agente — e é a
// base pra, depois, a cobrança nascer certa (parcelas → parcelamento no Asaas;
// recorrente → assinatura). Puro: importável por client, server e worker.
// ============================================================

export const PAYMENT_TYPES = ['single', 'recurring'] as const
export type PaymentType = (typeof PAYMENT_TYPES)[number]

export const RECURRENCES = ['weekly', 'monthly', 'bimonthly', 'quarterly', 'semiannual', 'yearly'] as const
export type Recurrence = (typeof RECURRENCES)[number]

export const PAYMENT_METHODS = ['pix', 'boleto', 'credit_card', 'debit_card', 'transfer', 'cash', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const MAX_INSTALLMENTS = 60

export const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  single: 'À vista',
  recurring: 'Recorrente',
}

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  weekly: 'semanal',
  monthly: 'mensal',
  bimonthly: 'bimestral',
  quarterly: 'trimestral',
  semiannual: 'semestral',
  yearly: 'anual',
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  pix: 'Pix',
  boleto: 'Boleto',
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  transfer: 'Transferência',
  cash: 'Dinheiro',
  other: 'Outro',
}

export interface PaymentTerms {
  paymentType: PaymentType | null
  recurrence: Recurrence | null
  installments: number | null
  paymentMethod: PaymentMethod | null
}

export interface RawPaymentTerms {
  paymentType?: string | null
  recurrence?: string | null
  installments?: number | string | null
  paymentMethod?: string | null
}

const isIn = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === 'string' && (list as readonly string[]).includes(v)

/**
 * Normaliza o que veio do formulário/API: valor fora da lista vira null;
 * recorrência só faz sentido em recorrente; parcelas só em à vista (1–60,
 * e 1 parcela = null, que é o mesmo que "sem parcelamento").
 */
export function normalizePaymentTerms(raw: RawPaymentTerms | null | undefined): PaymentTerms {
  const paymentType = isIn(PAYMENT_TYPES, raw?.paymentType) ? raw.paymentType : null
  const recurrence = paymentType === 'recurring' && isIn(RECURRENCES, raw?.recurrence) ? raw.recurrence : null
  let installments: number | null = null
  if (paymentType !== 'recurring' && raw?.installments != null && raw.installments !== '') {
    const n = Math.trunc(Number(raw.installments))
    if (Number.isFinite(n) && n >= 2 && n <= MAX_INSTALLMENTS) installments = n
  }
  const paymentMethod = isIn(PAYMENT_METHODS, raw?.paymentMethod) ? raw.paymentMethod : null
  return { paymentType, recurrence, installments, paymentMethod }
}

/** Selos curtos pro card: ["Recorrente · mensal", "Pix"] / ["3x", "Cartão de crédito"]. */
export function paymentTermsChips(raw: RawPaymentTerms | null | undefined): string[] {
  const t = normalizePaymentTerms(raw)
  const chips: string[] = []
  if (t.paymentType === 'recurring') chips.push(t.recurrence ? `Recorrente · ${RECURRENCE_LABEL[t.recurrence]}` : 'Recorrente')
  else if (t.installments) chips.push(`${t.installments}x`)
  else if (t.paymentType === 'single') chips.push('À vista')
  if (t.paymentMethod) chips.push(PAYMENT_METHOD_LABEL[t.paymentMethod])
  return chips
}

/** Uma linha pra detalhe/prompt: "Recorrente (mensal) · Pix" / "À vista em 3x · Cartão de crédito" / null. */
export function paymentTermsSummary(raw: RawPaymentTerms | null | undefined): string | null {
  const t = normalizePaymentTerms(raw)
  const parts: string[] = []
  if (t.paymentType === 'recurring') parts.push(t.recurrence ? `Recorrente (${RECURRENCE_LABEL[t.recurrence]})` : 'Recorrente')
  else if (t.paymentType === 'single') parts.push(t.installments ? `À vista em ${t.installments}x` : 'À vista')
  else if (t.installments) parts.push(`Em ${t.installments}x`)
  if (t.paymentMethod) parts.push(PAYMENT_METHOD_LABEL[t.paymentMethod])
  return parts.length ? parts.join(' · ') : null
}
