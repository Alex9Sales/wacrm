import { describe, expect, it } from 'vitest'

import { DEFAULT_POLICY, decide, readPolicy, type DecisionContext } from '@/lib/orchestration/policy'

import { withAutoSend } from './auto-send'

// 16/09 (GoLink): agente sem `caps` e com 30 mensagens/dia. A régua travava no
// 20º envio do dia, mesmo com o teto de Ajustar em 50.
const golink = readPolicy({ maxAutoMessagesPerDay: 30 })

const ctx = (policy: DecisionContext['policy'], usedToday: number): DecisionContext => ({
  action: 'collect_charges',
  policy,
  accountPaused: false,
  accountMode: 'on',
  withinHours: true,
  optedOut: false,
  humanActiveRecently: false,
  aiDisabledInConversation: false,
  usedToday,
  messagesToday: usedToday,
  usedForDealToday: 0,
})

describe('withAutoSend — o teto que vale é o de Ajustar', () => {
  it('Speed Gás (15/09 à tarde): 25 enviados, teto 50 → ainda cobra', () => {
    expect(decide(ctx(withAutoSend(golink, { autoSend: true, dailyCap: 50 }), 25)).decision).toBe('auto_execute')
  })

  it('bateu o teto de Ajustar → bloqueia', () => {
    expect(decide(ctx(withAutoSend(golink, { autoSend: true, dailyCap: 50 }), 50)).decision).toBe('blocked')
  })

  it('teto menor que o padrão também vale (dono pediu 10)', () => {
    expect(decide(ctx(withAutoSend(golink, { autoSend: true, dailyCap: 10 }), 10)).decision).toBe('blocked')
  })

  it('automático pela promoção (sem "Enviar sozinha"): também vale o teto de Ajustar', () => {
    const promovida = readPolicy({ actions: { collect_charges: 'auto' }, maxAutoMessagesPerDay: 30 })
    expect(decide(ctx(withAutoSend(promovida, { autoSend: false, dailyCap: 40 }), 25)).decision).toBe('auto_execute')
    expect(decide(ctx(withAutoSend(promovida, { autoSend: false, dailyCap: 40 }), 40)).decision).toBe('blocked')
  })

  it('sem "Enviar sozinha" a política do agente fica como está (pede aprovação)', () => {
    const p = withAutoSend(DEFAULT_POLICY, { autoSend: false, dailyCap: 50 })
    expect(p).toBe(DEFAULT_POLICY)
    expect(decide(ctx(p, 0)).decision).toBe('request_approval')
  })
})
