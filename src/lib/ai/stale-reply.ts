// ============================================================
// Resposta VELHA: a IA terminou de escrever, mas o cliente mandou outra
// mensagem enquanto ela gerava. Pura (sem banco) — o auto-reply busca os
// dados e aplica a decisão.
//
// Caso Adrieli (Família do Gás, 15/09): "Cartão" 07:01:05 → "Quantos minutos,
// eu tenho que trabalhar" 07:01:20 → a resposta ao "Cartão" saiu 07:01:29
// ("É crédito ou débito? O P-13 fica R$ 125…") e a rechecagem respondeu os
// minutos 18 s depois PERGUNTANDO DE NOVO crédito ou débito. Duas vezes
// seguidas na mesma manhã; a cliente: "Senhor amado, é crédito uma vez".
// O marcador de cobertura (reply-marker.ts) garante que a mensagem nova é
// respondida — mas não impede a resposta que já não serve de sair antes.
//
// Regra: se chegou mensagem do CLIENTE depois da leitura do histórico e o
// turno não gravou nada, a resposta não sai — a rechecagem responde tudo
// numa mensagem só, com o histórico inteiro. Chegou mensagem de HUMANO
// (atendente) no meio: a resposta não sai e ninguém regenera (humano ganha).
// Freio: no máximo MAX_STALE_DROPS descartes seguidos por conversa, pra
// cliente que escreve sem parar não ficar sem resposta.
// ============================================================

export const MAX_STALE_DROPS = 2
export const STALE_DROPS_TTL_SECONDS = 180
export const staleDropsKey = (conversationId: string) => `ai:stale-drops:${conversationId}`

export interface TurnEffects {
  /** Ferramenta de escrita gravou algo (pedido, cadastro…). */
  wroteSomething: boolean
  /** Pedido que vira card no funil. */
  hasOrder: boolean
  handoff: boolean
  /** Marcadores com efeito fora da conversa (transferir, cobrar, card, agenda,
   *  funil, perder, resolver, cobrança, nota interna). */
  consequentialDirective: boolean
}

/** O turno pode ser jogado fora sem perder nada além do texto? */
export function turnIsDroppable(t: TurnEffects): boolean {
  return !t.wroteSomething && !t.hasOrder && !t.handoff && !t.consequentialDirective
}

export type StaleDecision = 'send' | 'drop_regenerate' | 'drop_quiet'

/**
 * @param newest mensagem mais nova de cliente/atendente (não interna) DEPOIS da
 *   leitura do histórico, ou null.
 * @param dropsIncludingThis contador de descartes seguidos já contando este
 *   (undefined = Redis fora → envia, comportamento antigo). Só é consultado
 *   quando a mensagem nova é do cliente.
 */
export function staleReplyDecision(input: {
  snapshotAt: Date
  newest: { senderType: string | null; createdAt: string | null } | null
  droppable: boolean
  dropsIncludingThis?: number
}): StaleDecision {
  const { newest } = input
  if (!newest?.createdAt || !input.droppable) return 'send'
  if (new Date(newest.createdAt).getTime() <= input.snapshotAt.getTime()) return 'send'
  if (newest.senderType === 'agent') return 'drop_quiet'
  if (newest.senderType !== 'customer') return 'send'
  if (input.dropsIncludingThis === undefined) return 'send'
  return input.dropsIncludingThis <= MAX_STALE_DROPS ? 'drop_regenerate' : 'send'
}
