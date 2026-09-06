import { describe, expect, it } from 'vitest'

import { planReactivationBatches } from './reactivation-plan'

describe('planReactivationBatches — quem vai por qual canal', () => {
  it('quem já tem conversa num canal escolhido vai por ele', () => {
    const r = planReactivationBatches(
      [
        { contactId: 'a', preferredChannelId: 'ch2' },
        { contactId: 'b', preferredChannelId: null },
      ],
      [
        { channelId: 'ch1', remaining: 5 },
        { channelId: 'ch2', remaining: 5 },
      ],
    )
    expect(r.byChannel.get('ch2')).toEqual(['a'])
    expect(r.byChannel.get('ch1')).toEqual(['b'])
    expect(r.leftOver).toBe(0)
  })

  it('sem conversa: vai no canal com mais vaga — equilibra as linhas', () => {
    const r = planReactivationBatches(
      ['a', 'b', 'c', 'd'].map((id) => ({ contactId: id, preferredChannelId: null })),
      [
        { channelId: 'ch1', remaining: 2 },
        { channelId: 'ch2', remaining: 2 },
      ],
    )
    expect(r.byChannel.get('ch1')).toHaveLength(2)
    expect(r.byChannel.get('ch2')).toHaveLength(2)
  })

  it('teto do canal nunca estoura; quem não cabe fica pra amanhã', () => {
    const r = planReactivationBatches(
      ['a', 'b', 'c'].map((id) => ({ contactId: id, preferredChannelId: 'ch1' })),
      [{ channelId: 'ch1', remaining: 2 }],
    )
    expect(r.byChannel.get('ch1')).toEqual(['a', 'b'])
    expect(r.leftOver).toBe(1)
  })

  it('conversa num canal SEM vaga: não pula pra outro canal (a conversa dele é lá)', () => {
    const r = planReactivationBatches(
      [{ contactId: 'a', preferredChannelId: 'ch1' }],
      [
        { channelId: 'ch1', remaining: 0 },
        { channelId: 'ch2', remaining: 5 },
      ],
    )
    expect(r.byChannel.get('ch2')).toEqual([])
    expect(r.leftOver).toBe(1)
  })
})
