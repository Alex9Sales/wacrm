import { describe, expect, it } from 'vitest'
import {
  aiEnableWithAssigneeWarning,
  aiState,
  aiWaitingHint,
} from './conversation-ai-state'

describe('aiState', () => {
  it('canal fora da IA vence tudo', () => {
    expect(
      aiState({ aiActiveChannel: false, aiAutoreplyDisabled: false, assignedAgentId: 'u1' }),
    ).toBe('channel_off')
    expect(
      aiState({ aiActiveChannel: undefined, aiAutoreplyDisabled: true, assignedAgentId: null }),
    ).toBe('channel_off')
  })

  it('pausada na conversa vence o responsável', () => {
    expect(
      aiState({ aiActiveChannel: true, aiAutoreplyDisabled: true, assignedAgentId: 'u1' }),
    ).toBe('paused')
  })

  it('ligada com responsável = em espera (Dra. Andressa, GoLink 15/09)', () => {
    expect(
      aiState({ aiActiveChannel: true, aiAutoreplyDisabled: false, assignedAgentId: 'u1' }),
    ).toBe('waiting_assignee')
  })

  it('ligada sem responsável = respondendo', () => {
    expect(
      aiState({ aiActiveChannel: true, aiAutoreplyDisabled: null, assignedAgentId: '' }),
    ).toBe('responding')
    expect(
      aiState({ aiActiveChannel: true, aiAutoreplyDisabled: false, assignedAgentId: undefined }),
    ).toBe('responding')
  })
})

describe('textos', () => {
  it('dica com e sem nome', () => {
    expect(aiWaitingHint('Leonardo')).toBe(
      'Com responsável (Leonardo) a IA não responde. Tire o responsável pra ela voltar.',
    )
    expect(aiWaitingHint('  ')).toBe(
      'Com responsável a IA não responde. Tire o responsável pra ela voltar.',
    )
  })

  it('aviso ao ligar com e sem nome', () => {
    expect(aiEnableWithAssigneeWarning('Vitor')).toBe(
      'A conversa está com Vitor: enquanto tiver responsável a IA não responde.',
    )
    expect(aiEnableWithAssigneeWarning(null)).toBe(
      'A conversa está com uma pessoa da equipe: enquanto tiver responsável a IA não responde.',
    )
  })
})
