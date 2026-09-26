// ============================================================
// Engajamento de story: é uma PERGUNTA ou só um carinho?
//
// No Instagram, reagir a um story não é um evento próprio: chega como DM
// normal, com `reply_to.story` e o emoji no corpo. Para o CRM era uma
// mensagem do cliente como qualquer outra — e quem tem "mensagem de fora do
// horário" ligada respondia "estamos fechados, funcionamos de 8h às 18h" a
// quem só mandou um 🔥 no story. Quanto mais story a conta posta, mais o
// aviso vira ruído; o cliente não perguntou nada.
//
// Menção ("te mencionou no story") é o mesmo caso, e pior: a automação de
// story já responde sozinha quando está ligada, então o aviso seria a
// SEGUNDA mensagem automática no mesmo minuto.
//
// ⚠️ O limite importa: resposta a story COM pergunta ("quanto custa?") é
// lead, e aí o aviso de fora do horário é exatamente o que deve sair. Por
// isso a regra é estreita de propósito — só cala quando a mensagem é
// puramente emoji. Qualquer letra, dígito ou "?" derruba a exceção e o
// aviso sai como antes.
// ============================================================

/** Prefixo com que a resposta a story entra no histórico (instagram.ts). */
export const STORY_REPLY_PREFIX = '↩️ Respondeu seu story: '

export type StoryContext = 'reply' | 'mention'

/**
 * Só emoji (com modificador de tom, seletor de variação, ZWJ e espaço) e ao
 * menos um emoji de verdade. "10" e "?" NÃO passam: erra para o lado de
 * mandar o aviso, que é o comportamento de sempre.
 */
const EMOJI_ONLY =
  /^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍\s]+$/u

function isEmojiOnly(text: string): boolean {
  return EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}/u.test(text)
}

/**
 * A mensagem é só engajamento de story, sem pergunta dentro? Quem chama usa
 * isso para PULAR a resposta automática de fora do horário.
 *
 * Recebe o `contentText` como ele foi gravado — o prefixo de resposta a story
 * é removido aqui, para a decisão olhar o que a pessoa escreveu de fato.
 */
export function isStoryEngagementOnly(
  storyContext: StoryContext | null | undefined,
  contentText: string | null | undefined,
): boolean {
  if (!storyContext) return false
  // Menção nunca é pergunta: a pessoa nos marcou no story dela.
  if (storyContext === 'mention') return true

  // O prefixo termina em espaço: dar trim ANTES de recortar faria o
  // startsWith falhar e a mensagem inteira (com as palavras do prefixo) virar
  // "corpo" — ou seja, todo carinho seria lido como pergunta.
  const raw = contentText ?? ''
  const body = (
    raw.startsWith(STORY_REPLY_PREFIX)
      ? raw.slice(STORY_REPLY_PREFIX.length)
      : raw
  ).trim()
  // Resposta a story sem corpo nenhum também não é pergunta.
  if (!body) return true
  return isEmojiOnly(body)
}
