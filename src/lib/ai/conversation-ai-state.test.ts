import { describe, expect, it } from 'vitest'
import {
  aiEnableWithAssigneeWarning,
  aiHandoffPauseHint,
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

  it('ligada com responsável = em espera (Dra. Helena Teste, GoLink 15/09)', () => {
    expect(
      aiState({ aiActiveChannel: true, aiAutoreplyDisabled: false, assignedAgentId: 'u1' }),
    ).toBe('waiting_assignee')
  })

  it('🙋 pausa pós-transferência vigente = "handoff_pause"; vencida = respondendo', () => {
    const now = Date.parse('2026-10-01T15:00:00.000Z')
    const base = { aiActiveChannel: true, aiAutoreplyDisabled: false, assignedAgentId: null, now }
    expect(aiState({ ...base, aiPausedUntil: '2026-10-01T15:30:00.000Z' })).toBe('handoff_pause')
    expect(aiState({ ...base, aiPausedUntil: '2026-10-01T14:30:00.000Z' })).toBe('responding')
    expect(aiState({ ...base, aiPausedUntil: null })).toBe('responding')
  })

  it('🙋 a ordem dos gates do auto-reply: desligada e com responsável vencem a pausa', () => {
    const now = Date.parse('2026-10-01T15:00:00.000Z')
    const aiPausedUntil = '2026-10-01T15:30:00.000Z'
    expect(
      aiState({ aiActiveChannel: true, aiAutoreplyDisabled: true, assignedAgentId: null, aiPausedUntil, now }),
    ).toBe('paused')
    expect(
      aiState({ aiActiveChannel: true, aiAutoreplyDisabled: false, assignedAgentId: 'u1', aiPausedUntil, now }),
    ).toBe('waiting_assignee')
    expect(aiHandoffPauseHint('14:30')).toBe(
      'A IA pediu um humano e está pausada até 14:30. Volta sozinha se a pessoa escrever e ninguém responder.',
    )
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
