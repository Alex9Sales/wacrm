// ============================================================
// 🔁 Episódio de conversa — quando o teto de respostas da IA deve zerar.
//
// Caso Poliana (Família do Gás, 05/09 08:26): cliente recorrente, conversa
// aberta desde 26/08, 22 respostas da IA ao longo de 7 dias. O teto de 10
// era POR VIDA DA CONVERSA — e conversa de WhatsApp com cliente de gás nunca
// fecha. Resultado: a cada ~3 pedidos a IA calava no meio de uma venda
// ("Sim" pro Pix de R$ 113 e ninguém respondeu).
//
// O teto existe pra segurar loop (IA respondendo sem parar). Um silêncio de
// algumas horas quebra qualquer loop. Então o contador passa a valer por
// EPISÓDIO: se a IA não fala há mais de N horas, o que vier agora é um
// pedido novo, e ela recomeça do zero.
//
// Parte pura, com teste. Sem 'server-only'.
// ============================================================

/** Horas sem a IA falar para a próxima mensagem contar como episódio novo. */
export const EPISODE_GAP_HOURS = 4

/**
 * A IA está calada há tempo suficiente para isto ser um pedido novo?
 * `lastBotAt` nulo = nunca falou nesta conversa → episódio novo por definição.
 */
export function isNewEpisode(lastBotAt: string | Date | null, now: Date = new Date(), gapHours = EPISODE_GAP_HOURS): boolean {
  if (!lastBotAt) return true
  const last = lastBotAt instanceof Date ? lastBotAt : new Date(lastBotAt)
  if (Number.isNaN(last.getTime())) return true
  return now.getTime() - last.getTime() >= gapHours * 3_600_000
}
