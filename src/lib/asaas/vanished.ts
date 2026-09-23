// ============================================================
// 🕳️ A cobrança sumiu da carteira — e agora, o que ela virou?
//
// Quando uma cobrança some da listagem do Asaas, a varredura fecha a linha
// (`open = false`) e o STATUS ficava como estava. Resultado: 8 linhas no banco
// fechadas mas ainda escritas "OVERDUE" — cobrança apagada lá parecia vencida
// aqui, no histórico e em qualquer relatório que olhe o status.
//
// Sumir tem duas causas e elas não são a mesma coisa:
//   • foi PAGA (o webhook costuma chegar antes, mas pode falhar);
//   • foi APAGADA ou estornada no Asaas.
// Então a gente pergunta ao Asaas o que aconteceu com aquele id, em vez de
// adivinhar. Se não der para perguntar, o status fica como está — melhor um
// status velho do que um inventado.
//
// Puro + executor. Sem 'server-only': roda no worker.
// ============================================================

import { getPayment, type AsaasCredential, type AsaasPayment } from './collections'

/** Status que damos a uma cobrança apagada no Asaas. */
export const DELETED_STATUS = 'DELETED'

/** Quantas reconsultas por rodada — sumir é raro; isto é um teto de segurança. */
export const MAX_VANISHED_LOOKUPS = 10

/**
 * O status que a linha deve guardar depois de sumir da carteira. PURA.
 *
 * `payment` é o que o Asaas respondeu sobre aquele id (ou null quando não deu
 * para consultar). Devolve null quando não há o que mudar.
 */
export function statusAfterVanish(
  payment: Pick<AsaasPayment, 'status' | 'deleted'> | null,
  statusAtual: string | null,
): string | null {
  if (!payment) return null
  if (payment.deleted === true) return statusAtual === DELETED_STATUS ? null : DELETED_STATUS
  const novo = (payment.status ?? '').trim().toUpperCase()
  if (!novo || novo === (statusAtual ?? '').trim().toUpperCase()) return null
  return novo
}

export interface VanishedCharge {
  id: string
  asaasId: string
  status: string | null
}

/**
 * Descobre o status real de cada cobrança que sumiu. Nunca lança: o que não
 * der para consultar fica de fora e a linha segue com o status que tinha.
 */
export async function resolveVanishedStatuses(
  cred: AsaasCredential,
  charges: readonly VanishedCharge[],
): Promise<{ id: string; status: string }[]> {
  const out: { id: string; status: string }[] = []
  for (const c of charges.slice(0, MAX_VANISHED_LOOKUPS)) {
    try {
      const pago = await getPayment(cred, c.asaasId)
      const novo = statusAfterVanish(pago, c.status)
      if (novo) out.push({ id: c.id, status: novo })
    } catch (err) {
      // 404 = apagada de vez no Asaas; o resto é rede/limite e fica para a
      // próxima rodada. Nos dois casos, não inventamos status aqui.
      const msg = err instanceof Error ? err.message : String(err)
      if (/\b404\b/.test(msg)) out.push({ id: c.id, status: DELETED_STATUS })
    }
  }
  return out
}
