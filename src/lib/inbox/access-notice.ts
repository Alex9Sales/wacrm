// ============================================================
// Aviso quando um link /inbox?c=<id> não abre. PURO (client-safe).
//
// 15/09 (GoLink, Vitor): o "Chat" do disparo levava pra uma conversa no
// número do Leonardo e a caixa dizia "está com outra pessoa (sem acesso) ou
// foi apagada" — as duas coisas juntas, sem dizer qual. Agora o servidor diz
// se a conversa existe e só não é sua (com o número e com quem está) ou se
// não existe mais.
// ============================================================

export type ConversationAccessInfo =
  /** Abre normalmente (o carregamento anterior falhou por outro motivo). */
  | { status: 'ok' }
  /** Existe na conta, mas quem pediu não pode abrir. */
  | { status: 'no_access'; channelName: string | null; holderName: string | null }
  /** Não existe nesta conta (apagada ou link errado). */
  | { status: 'not_found' }

export function conversationUnavailableMessage(info: ConversationAccessInfo | null): string {
  if (info?.status === 'no_access') {
    const where = info.channelName
      ? ` Ela está no número ${info.channelName}${info.holderName ? ` (${info.holderName})` : ''}.`
      : info.holderName
        ? ` Ela está com ${info.holderName}.`
        : ''
    return `Você não tem acesso a esta conversa.${where} Peça a um admin pra atribuir a você.`
  }
  if (info?.status === 'not_found') {
    return 'Esta conversa não existe mais: foi apagada ou o link está errado.'
  }
  return 'Não consegui abrir esta conversa agora. Tente de novo em instantes.'
}
