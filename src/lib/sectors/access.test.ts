import { describe, expect, it } from 'vitest'

import { agentCanReadRow } from './access'

const base = {
  userId: 'wilian',
  conversationId: 'c1',
  sectorId: null as string | null,
  assignedAgentId: null as string | null,
  isPrivate: false,
  sectorIds: new Set<string>(),
  adminIds: new Set<string>(['joao']),
  participantIds: new Set<string>(),
}

describe('agentCanReadRow — canal dedicado', () => {
  const dedicated = new Map([['ch-wilian', 'wilian'], ['ch-vitor', 'vitor']])

  it('o dono vê as conversas do canal dele, mesmo sem atribuição e sem setor', () => {
    expect(agentCanReadRow({ ...base, channelId: 'ch-wilian', dedicatedByChannel: dedicated })).toBe(true)
  })

  it('outro atendente NÃO vê conversa de canal dedicado a alguém', () => {
    expect(agentCanReadRow({ ...base, channelId: 'ch-vitor', dedicatedByChannel: dedicated })).toBe(false)
  })

  it('canal comum segue a regra normal (fila geral sem dono é visível)', () => {
    expect(agentCanReadRow({ ...base, channelId: 'ch-comum', dedicatedByChannel: dedicated })).toBe(true)
  })

  it('atribuída explicitamente a mim → leio, mesmo em canal dedicado a outro', () => {
    expect(
      agentCanReadRow({ ...base, assignedAgentId: 'wilian', channelId: 'ch-vitor', dedicatedByChannel: dedicated }),
    ).toBe(true)
  })

  it('conversa do admin continua invisível, mesmo no meu canal dedicado', () => {
    expect(
      agentCanReadRow({ ...base, assignedAgentId: 'joao', channelId: 'ch-wilian', dedicatedByChannel: dedicated }),
    ).toBe(false)
  })

  it('sem mapa (chamadas antigas) nada muda', () => {
    expect(agentCanReadRow({ ...base, channelId: 'ch-vitor' })).toBe(true)
  })
})
