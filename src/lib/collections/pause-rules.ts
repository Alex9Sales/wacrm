// ============================================================
// Pausa da régua: de quem é e quando some — PURO (client-safe, testável).
//
// 16/09 (Reboque Modelo, GoLink): a IA leu "me passa o link aqui pra eu acertar"
// como pedido de ACORDO e pausou a régua. Ele pagou tudo, a cobrança saiu da
// carteira — e a pausa ficou valendo para sempre, sem aparecer em tela
// nenhuma (a carteira e a lateral só mostravam quem tem cobrança aberta).
// Cinco dias e meio invisível até o João retomar na mão.
//
// Regras:
//   • pausa que a IA pôs (acordo/contestação) sai sozinha quando o cliente
//     quita o que estava vencido — é um estado da conversa, não uma decisão;
//   • pausa que uma PESSOA pôs ("não cobrar") nunca some sozinha: fica visível
//     e com botão Retomar;
//   • a IA nunca passa por cima de uma pausa humana.
// ============================================================

/** Motivos que a IA grava (lib/collections/reply.ts). */
export const AI_PAUSE_REASONS = ['Cliente pediu acordo/parcelamento', 'Cliente contesta a cobrança'] as const

export type PauseSource = 'human' | 'ai' | 'revert'

export interface PauseState {
  paused: boolean
  pausedSource: string | null
  pausedReason: string | null
}

/** A pausa é da IA? Linha antiga (antes da migração 0177) sem origem: vale o motivo. */
export function isAiPause(st: Pick<PauseState, 'pausedSource' | 'pausedReason'>): boolean {
  if (st.pausedSource === 'ai') return true
  if (st.pausedSource != null) return false
  return (AI_PAUSE_REASONS as readonly string[]).includes(st.pausedReason ?? '')
}

export type PauseAfterSettle = 'lift' | 'keep_human' | 'keep_owes' | 'none'

/**
 * O que fazer com a pausa quando uma cobrança é paga.
 * @param firstSettle é o PRIMEIRO pagamento desta cobrança — o cartão manda
 *   CONFIRMED e ~30 dias depois RECEIVED, e o Asaas reenvia eventos: o
 *   segundo aviso não pode tirar uma pausa nova, de outra dívida.
 * @param stillOwes ainda há cobrança aberta na carteira do contato.
 * @param asaasOpen cobranças em aberto no ASAAS (a vencer + vencidas) — a
 *   carteira só espelha as vencidas, então parcela a vencer só aparece aqui.
 *   null = não deu para consultar (pausa da IA fica, sem nota); undefined =
 *   não consultado (pausa humana não precisa).
 */
export function pauseAfterSettle(
  st: PauseState | null | undefined,
  ev: { firstSettle: boolean; stillOwes: boolean; asaasOpen?: number | null },
): PauseAfterSettle {
  if (!st?.paused || !ev.firstSettle || ev.stillOwes) return 'none'
  if (!isAiPause(st)) return 'keep_human'
  if (ev.asaasOpen === null || ev.asaasOpen === undefined) return 'none'
  return ev.asaasOpen > 0 ? 'keep_owes' : 'lift'
}

export function pauseSourceLabel(source: string | null, reason: string | null): string {
  if (isAiPause({ pausedSource: source, pausedReason: reason })) return 'pela IA'
  if (source === 'revert') return 'ao marcar a cobrança como errada'
  return 'pela equipe'
}
