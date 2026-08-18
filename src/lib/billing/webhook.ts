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

/** Próximo vencimento (+1 mês) a partir de uma data (ou de agora). ISO string. */
export function addOneMonthISO(fromDate?: string): string {
  const base = fromDate ? new Date(fromDate) : new Date()
  const d = Number.isNaN(base.getTime()) ? new Date() : base
  const next = new Date(d)
  next.setMonth(next.getMonth() + 1)
  return next.toISOString()
}
