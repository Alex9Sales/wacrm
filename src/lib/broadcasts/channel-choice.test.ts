import { describe, expect, it } from 'vitest'

import { channelOwnerLabel, defaultBroadcastChannelId, otherPersonOwner } from './channel-choice'

// 15/09 (GoLink): o 1º canal em ordem alfabética era o número do Leonardo e o
// disparo do Vitor saiu por ele sem ninguém perceber.
const LEONARDO = 'u-leonardo'
const VITOR = 'u-vitor'
const channels = [
  { id: 'atendimento', dedicated_user_id: LEONARDO, dedicated_user_name: 'Leonardo Financeiro' },
  { id: 'cobrancas', dedicated_user_id: 'u-joao', dedicated_user_name: 'João' },
  { id: 'vitor', dedicated_user_id: VITOR, dedicated_user_name: 'Vitor' },
]

describe('defaultBroadcastChannelId', () => {
  it('marca o número de quem está criando, não o 1º da lista', () => {
    expect(defaultBroadcastChannelId(channels, VITOR)).toBe('vitor')
  })

  it('sem número próprio: o 1º canal que não é de ninguém', () => {
    expect(defaultBroadcastChannelId([...channels, { id: 'empresa', dedicated_user_id: null }], 'u-wilian')).toBe('empresa')
  })

  it('todos têm dono e nenhum é meu: o 1º (com aviso na tela)', () => {
    expect(defaultBroadcastChannelId(channels, 'u-wilian')).toBe('atendimento')
    expect(defaultBroadcastChannelId([], VITOR)).toBe('')
  })
})

describe('aviso de número de outra pessoa', () => {
  it('diz de quem é o número', () => {
    expect(otherPersonOwner(channels[0], VITOR)).toBe('Leonardo Financeiro')
    expect(otherPersonOwner(channels[2], VITOR)).toBeNull()
    expect(otherPersonOwner({ id: 'empresa', dedicated_user_id: null }, VITOR)).toBeNull()
  })

  it('rótulo na lista', () => {
    expect(channelOwnerLabel(channels[0], VITOR)).toBe('número de Leonardo Financeiro')
    expect(channelOwnerLabel(channels[2], VITOR)).toBe('seu número')
    expect(channelOwnerLabel({ id: 'empresa' }, VITOR)).toBeNull()
  })
})

// Revisão 15/09: número próprio desconectado ou Gmail próprio não viram padrão.
describe('defaultBroadcastChannelId — status e tipo', () => {
  const JOAO = 'u-joao'
  it('meu número desconectado perde pro meu conectado', () => {
    const list = [
      { id: 'cobrancas', dedicated_user_id: JOAO, status: 'disconnected' },
      { id: 'joao', dedicated_user_id: JOAO, status: 'connected' },
    ]
    expect(defaultBroadcastChannelId(list, JOAO)).toBe('joao')
  })

  it('Gmail meu não é padrão do disparo de texto, mas é do disparo de e-mail', () => {
    const list = [
      { id: 'e-mail-joao', dedicated_user_id: JOAO, status: 'connected', is_email: true },
      { id: 'joao', dedicated_user_id: JOAO, status: 'connected' },
    ]
    expect(defaultBroadcastChannelId(list, JOAO)).toBe('joao')
    expect(defaultBroadcastChannelId(list, JOAO, { email: true })).toBe('e-mail-joao')
  })

  it('meu desconectado + da empresa conectado → o da empresa', () => {
    const list = [
      { id: 'meu', dedicated_user_id: JOAO, status: 'disconnected' },
      { id: 'empresa', dedicated_user_id: null, status: 'connected' },
    ]
    expect(defaultBroadcastChannelId(list, JOAO)).toBe('empresa')
  })
})

