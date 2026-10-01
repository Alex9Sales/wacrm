// ============================================================
// O que a caixa de entrada faz com um aviso `message.received`. PURO
// (client-safe) — o handler do inbox só executa o plano.
// ============================================================

export interface InboxMessageEvent {
  conversationId?: string
  /** Aba que fez o envio pelo composer (ver `lib/realtime/origin-tab.ts`). */
  originTabId?: string
}

export interface InboxMessageEventPlan {
  /** Sem conversa no aviso: recarrega lista e thread inteiros. */
  fullResync: boolean
  /** Zera a não lida no banco antes de recarregar (conversa aberta). */
  markRead: boolean
  /** Atualiza a linha da lista (prévia, horário, atribuição). */
  hydrate: boolean
  /** Recarrega as mensagens do thread aberto. */
  refetchThread: boolean
}

export function planInboxMessageEvent(
  event: InboxMessageEvent,
  ctx: { tabId: string; activeConversationId: string | null | undefined },
): InboxMessageEventPlan {
  const convId = event.conversationId
  if (!convId) {
    return { fullResync: true, markRead: false, hydrate: false, refetchThread: false }
  }

  // 01/10: o eco do próprio envio desta aba. A bolha otimista (`temp-…`) já
  // está na tela e só troca pelo id real quando o POST responde; recarregar o
  // thread antes disso põe a mensagem real AO LADO da temp e o rename deixa
  // duas com o mesmo id. A linha da lista ainda atualiza — o hydrate zera a
  // não lida da conversa aberta, e sem refetch da lista não há bolinha a
  // ressuscitar, então o markRead também sobra.
  if (event.originTabId && event.originTabId === ctx.tabId) {
    return { fullResync: false, markRead: false, hydrate: true, refetchThread: false }
  }

  const isOpen = ctx.activeConversationId === convId
  return { fullResync: false, markRead: isOpen, hydrate: true, refetchThread: isOpen }
}
