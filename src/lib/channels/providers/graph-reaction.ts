// ============================================================
// Reação no Instagram Direct e no Messenger (Graph API).
//
// 25/09 (Rafael Odonto): os dois canais declaravam `reactions: true` nas
// capabilities e NÃO tinham envio nenhum. O Instagram é o 2º canal mais
// movimentado da conta dele (161 conversas), então reagir ali era o defeito
// visível: a bolha mostrava o emoji, a rota recusava e a tela desfazia.
//
// Formato (igual nos dois): POST {graphBase}/{id}/messages com
//   { recipient: { id }, sender_action: 'react',   payload: { message_id, reaction } }
//   { recipient: { id }, sender_action: 'unreact', payload: { message_id } }
//
// ⚠️ O QUE A DOC NÃO DIZ: qual formato o campo `reaction` aceita. O guia do
// Instagram mostra um NOME (`"reaction": "love"`); a referência de
// /PAGE-ID/messages diz que `payload` "supports emoji". Os nomes são os
// mesmos que o webhook de reação entrega (smile, angry, sad, wow, love, like,
// dislike). Em vez de chutar, o código tenta o nome quando existe e cai no
// emoji cru se a API recusar — e vice-versa. Quando soubermos qual vale,
// simplificar aqui.
// ============================================================

/** Emoji → nome de reação da Meta (o vocabulário do webhook). */
const REACTION_NAMES: Record<string, string> = {
  '👍': 'like',
  '❤️': 'love',
  '❤': 'love',
  '😍': 'love',
  '😂': 'smile',
  '😆': 'smile',
  '😊': 'smile',
  '😮': 'wow',
  '😯': 'wow',
  '😢': 'sad',
  '😭': 'sad',
  '😡': 'angry',
  '😠': 'angry',
  '👎': 'dislike',
}

/**
 * Os valores de `reaction` a tentar, em ordem de aposta. O nome vem primeiro
 * porque é o único formato que a doc mostra por escrito; o emoji cru é o
 * fallback (e o único caminho para emoji sem nome, tipo 🙏).
 */
export function reactionCandidates(emoji: string): string[] {
  const name = REACTION_NAMES[emoji]
  return name ? [name, emoji] : [emoji]
}

export interface GraphReactionArgs {
  /** POST {graphBase}/{id}/messages — ig_id no Instagram, page_id no Messenger. */
  url: string
  token: string
  /** IGSID / PSID de quem recebe. */
  recipientId: string
  /** mid da mensagem alvo. */
  targetMessageId: string
  /** Emoji escolhido, ou '' para remover a reação. */
  emoji: string
  /** POST que já trata erro da Graph (cada provider tem o seu). */
  post: (url: string, token: string, body: unknown) => Promise<unknown>
}

/**
 * Envia (ou remove) a reação. Emoji vazio = `unreact`.
 *
 * Com emoji, tenta cada candidato e só desiste quando TODOS falham — aí
 * relança o primeiro erro, que é o que descreve a tentativa mais provável.
 */
export async function sendGraphReaction(args: GraphReactionArgs): Promise<void> {
  const recipient = { id: args.recipientId }

  if (!args.emoji) {
    await args.post(args.url, args.token, {
      recipient,
      sender_action: 'unreact',
      payload: { message_id: args.targetMessageId },
    })
    return
  }

  let firstError: unknown = null
  for (const reaction of reactionCandidates(args.emoji)) {
    try {
      await args.post(args.url, args.token, {
        recipient,
        sender_action: 'react',
        payload: { message_id: args.targetMessageId, reaction },
      })
      return
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError instanceof Error
    ? firstError
    : new Error('reação recusada pela Graph API')
}
