// ============================================================
// Parcela + a conta do Asaas onde ela existe — PURO (sem banco).
//
// 16/09 (GoLink, duas contas do Asaas): o lembrete e o aviso de cobrança nova
// juntam num pedido só as parcelas de uma pessoa, mas guardavam UMA conexão
// (a da primeira parcela vista). Na hora de enviar, a reconferência consultava
// TODAS as parcelas com a chave dessa conta — a da outra conta "não existe",
// o envio falhava 3x, virava 'failed' e a rodada seguinte recriava o mesmo
// pedido a cada 10 min. Quebra até com UMA parcela: a da conta 1 já lembrada
// sai do pedido e sobra só a da conta 2, com o connectionId da conta 1.
//
// Formato novo do pedido: `paymentRefs` [{asaasId, connectionId}] +
// `asaasIds` plano (as travas de "já lembrado"/"já avisado" leem ele) +
// `connectionId` só quando é UMA conta (leitor antigo durante o deploy).
// ============================================================

import type { AsaasCredential } from '@/lib/asaas/collections'

export interface PaymentRef {
  asaasId: string
  connectionId: string
}

export function paymentRefsPayload(refs: PaymentRef[]): {
  paymentRefs: PaymentRef[]
  asaasIds: string[]
  connectionId?: string
} {
  const contas = new Set(refs.map((r) => r.connectionId))
  return {
    paymentRefs: refs.map(({ asaasId, connectionId }) => ({ asaasId, connectionId })),
    asaasIds: refs.map((r) => r.asaasId),
    ...(contas.size === 1 ? { connectionId: refs[0].connectionId } : {}),
  }
}

/** Parcelas do pedido. Novo: `paymentRefs`. Antigo (até 16/09): `connectionId`
 *  único + `asaasIds`. Referência quebrada = [] (não reconfere pela metade). */
export function paymentRefsFrom(payload: Record<string, unknown>): PaymentRef[] {
  const out: PaymentRef[] = []
  const seen = new Set<string>()
  const add = (asaasId: unknown, connectionId: unknown): boolean => {
    if (typeof asaasId !== 'string' || !asaasId || typeof connectionId !== 'string' || !connectionId) return false
    if (!seen.has(asaasId)) {
      seen.add(asaasId)
      out.push({ asaasId, connectionId })
    }
    return true
  }
  if (Array.isArray(payload.paymentRefs)) {
    const ok = payload.paymentRefs.every((it) => {
      const r = (it ?? {}) as { asaasId?: unknown; connectionId?: unknown }
      return add(r.asaasId, r.connectionId)
    })
    return ok ? out : []
  }
  if (Array.isArray(payload.asaasIds)) {
    for (const id of payload.asaasIds) {
      if (!add(id, payload.connectionId)) return []
    }
  }
  return out
}

export function refsByConnection(refs: PaymentRef[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const r of refs) m.set(r.connectionId, [...(m.get(r.connectionId) ?? []), r.asaasId])
  return m
}

export type CredLookup = (connectionId: string) => Promise<{ cred: AsaasCredential; label: string } | { error: string }>

/**
 * Reconfere cada parcela NA CONTA DELA. Tudo ou nada: qualquer consulta que
 * falha recusa o envio (com o nome da conta), nunca manda pela metade.
 */
export async function reconferPayments(
  refs: PaymentRef[],
  credFor: CredLookup,
  getPayment: (cred: AsaasCredential, id: string) => Promise<{ status?: string | null }>,
  aceitas: readonly string[],
): Promise<{ ok: true; pending: string[] } | { ok: false; error: string }> {
  if (!refs.length) return { ok: false, error: 'Sem referência das parcelas — não dá para reconferir no Asaas.' }
  const pending: string[] = []
  for (const [connectionId, ids] of refsByConnection(refs)) {
    const found = await credFor(connectionId)
    if ('error' in found) return { ok: false, error: found.error }
    for (const id of ids) {
      try {
        const p = await getPayment(found.cred, id)
        if (aceitas.includes(String(p.status).toUpperCase())) pending.push(id)
      } catch (err) {
        return {
          ok: false,
          error: `Não deu para reconferir no Asaas (${found.label}) agora: ${err instanceof Error ? err.message : 'falha'}`,
        }
      }
    }
  }
  if (!pending.length) return { ok: false, error: 'A parcela já foi paga ou cancelada no Asaas — nada foi enviado.' }
  return { ok: true, pending }
}
