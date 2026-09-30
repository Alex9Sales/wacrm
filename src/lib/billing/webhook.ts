// ============================================================
// Helpers puros do webhook do Asaas (sem I/O — testáveis). O evento de pagamento
// confirmado ativa a conta; a rota (/api/webhooks/asaas) faz a escrita no banco.
// Docs: eventos de cobrança do Asaas (PAYMENT_*).
// ============================================================

/** Eventos que ATIVAM a conta (pagamento entrou de fato). */
export const ACTIVATE_EVENTS = new Set([
  'PAYMENT_CONFIRMED', // cartão/pix confirmado (compensação em D+1 no boleto)
  'PAYMENT_RECEIVED', // valor efetivamente creditado
  'PAYMENT_RECEIVED_IN_CASH', // baixa manual
])

export function isActivateEvent(event: unknown): boolean {
  return typeof event === 'string' && ACTIVATE_EVENTS.has(event)
}

/** Extrai as chaves que ligam o pagamento à conta (org). */
export function extractOrgRef(payment: unknown): {
  externalReference: string | null
  subscriptionId: string | null
} {
  const p = (payment ?? {}) as Record<string, unknown>
  const externalReference =
    typeof p.externalReference === 'string' && p.externalReference
      ? p.externalReference
      : null
  const subscriptionId =
    typeof p.subscription === 'string' && p.subscription ? p.subscription : null
  return { externalReference, subscriptionId }
}

import { CYCLES, parseBillingCycle } from './cycle'

/** Próximo vencimento (+1 mês) a partir de uma data (ou de agora). ISO string. */
export function addOneMonthISO(fromDate?: string): string {
  const base = fromDate ? new Date(fromDate) : new Date()
  const d = Number.isNaN(base.getTime()) ? new Date() : base
  const next = new Date(d)
  next.setMonth(next.getMonth() + 1)
  return next.toISOString()
}

/**
 * Próximo vencimento RESPEITANDO O CICLO do contrato (29/09).
 *
 * O webhook de pagamento sempre somou um mês. Isso estava certo enquanto todo
 * mundo era mensal — mas a Appia fechou SEMESTRAL e pagou os R$ 780 de uma vez.
 * Somar um mês marcaria o próximo vencimento para daqui a 30 dias e o lembrete
 * cobraria de novo em outubro um contrato pago até março.
 *
 * `nextChargeDate` já sabia a conta (e já trata 31 de agosto + 6 meses); faltava
 * o webhook perguntar a ela. Ciclo desconhecido cai em mensal, que é o que o
 * sistema sempre fez — errar para menos aqui só antecipa uma conversa, errar
 * para mais cobra alguém indevidamente.
 */
export function nextDueForCycle(fromDate: string | undefined, cycle: unknown): string {
  const parsed = parseBillingCycle(cycle)
  const meses = parsed ? CYCLES[parsed].months : 1
  const base = fromDate ? new Date(fromDate) : new Date()
  const d = Number.isNaN(base.getTime()) ? new Date() : base

  // ⚠️ Conta em UTC, não na hora da máquina. O Asaas manda "2026-08-31", que
  // vira meia-noite UTC — e `getDate()` num servidor a oeste devolve 30, não
  // 31. O dia do vencimento não pode depender de onde o processo roda.
  const ano = d.getUTCFullYear()
  const mes = d.getUTCMonth()
  const dia = d.getUTCDate()
  // Último dia do mês de destino: 31 de agosto + 6 meses não vira 3 de março.
  const ultimoDia = new Date(Date.UTC(ano, mes + meses + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(ano, mes + meses, Math.min(dia, ultimoDia), 12, 0, 0),
  ).toISOString()
}
