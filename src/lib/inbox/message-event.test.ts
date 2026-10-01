import { describe, expect, it } from 'vitest'

import { planInboxMessageEvent } from './message-event'

const TAB = 'aba-deste-navegador'
const OTHER_TAB = 'aba-do-colega'

describe('planInboxMessageEvent', () => {
  it('sem conversa no aviso: recarrega tudo', () => {
    expect(planInboxMessageEvent({}, { tabId: TAB, activeConversationId: 'conv-1' })).toEqual({
      fullResync: true,
      markRead: false,
      hydrate: false,
      refetchThread: false,
    })
  })

  it('eco do envio DESTA aba na conversa aberta: só a linha da lista, sem refetch do thread', () => {
    // A bolha otimista ainda pode estar como temp-…; recarregar o thread aqui
    // deixava duas bolhas com o mesmo id.
    expect(
      planInboxMessageEvent(
        { conversationId: 'conv-1', originTabId: TAB },
        { tabId: TAB, activeConversationId: 'conv-1' },
      ),
    ).toEqual({ fullResync: false, markRead: false, hydrate: true, refetchThread: false })
  })

  it('eco desta aba depois de trocar de conversa: também só a linha', () => {
    expect(
      planInboxMessageEvent(
        { conversationId: 'conv-1', originTabId: TAB },
        { tabId: TAB, activeConversationId: 'conv-2' },
      ),
    ).toEqual({ fullResync: false, markRead: false, hydrate: true, refetchThread: false })
  })

  it('colega respondeu na conversa que eu tenho aberta: marca lida, hidrata e recarrega o thread', () => {
    expect(
      planInboxMessageEvent(
        { conversationId: 'conv-1', originTabId: OTHER_TAB },
        { tabId: TAB, activeConversationId: 'conv-1' },
      ),
    ).toEqual({ fullResync: false, markRead: true, hydrate: true, refetchThread: true })
  })

  it('colega respondeu em outra conversa: só a linha da lista', () => {
    expect(
      planInboxMessageEvent(
        { conversationId: 'conv-1', originTabId: OTHER_TAB },
        { tabId: TAB, activeConversationId: 'conv-2' },
      ),
    ).toEqual({ fullResync: false, markRead: false, hydrate: true, refetchThread: false })
  })

  it('aviso sem aba de origem (cliente, IA, celular) segue como antes', () => {
    expect(
      planInboxMessageEvent({ conversationId: 'conv-1' }, { tabId: TAB, activeConversationId: 'conv-1' }),
    ).toEqual({ fullResync: false, markRead: true, hydrate: true, refetchThread: true })
    expect(
      planInboxMessageEvent({ conversationId: 'conv-1' }, { tabId: TAB, activeConversationId: null }),
    ).toEqual({ fullResync: false, markRead: false, hydrate: true, refetchThread: false })
  })

  it('originTabId vazio não casa com nada', () => {
    expect(
      planInboxMessageEvent(
        { conversationId: 'conv-1', originTabId: '' },
        { tabId: '', activeConversationId: 'conv-1' },
      ).refetchThread,
    ).toBe(true)
  })
})
