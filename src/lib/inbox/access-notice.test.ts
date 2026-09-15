import { describe, expect, it } from 'vitest'

import { conversationUnavailableMessage } from './access-notice'

// 15/09 (GoLink): "sem acesso OU apagada" não dizia qual das duas.
describe('conversationUnavailableMessage', () => {
  it('sem acesso: diz o número e com quem está', () => {
    expect(
      conversationUnavailableMessage({ status: 'no_access', channelName: 'Atendimento', holderName: 'Leonardo' }),
    ).toBe('Você não tem acesso a esta conversa. Ela está no número Atendimento (Leonardo). Peça a um admin pra atribuir a você.')
  })

  it('sem acesso sem número conhecido', () => {
    expect(conversationUnavailableMessage({ status: 'no_access', channelName: null, holderName: 'Leonardo' })).toBe(
      'Você não tem acesso a esta conversa. Ela está com Leonardo. Peça a um admin pra atribuir a você.',
    )
    expect(conversationUnavailableMessage({ status: 'no_access', channelName: null, holderName: null })).toBe(
      'Você não tem acesso a esta conversa. Peça a um admin pra atribuir a você.',
    )
  })

  it('apagada é outra mensagem', () => {
    expect(conversationUnavailableMessage({ status: 'not_found' })).toMatch(/não existe mais/)
  })

  it('sem resposta do servidor: não afirma nenhuma das duas', () => {
    expect(conversationUnavailableMessage(null)).toMatch(/Tente de novo/)
  })
})
