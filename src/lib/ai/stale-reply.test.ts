import { describe, expect, it } from 'vitest'

import { MAX_STALE_DROPS, staleReplyDecision, turnIsDroppable } from './stale-reply'

const semEfeito = { wroteSomething: false, hasOrder: false, handoff: false, consequentialDirective: false }
// Leitura do histórico da resposta ao "Cartão" (caso Bruna Teste, 15/09; horários arredondados).
const leitura = new Date('2026-09-15T11:00:00.000Z')

describe('turnIsDroppable — só descarta o que não deixou rastro', () => {
  it('turno só de texto pode ser descartado', () => {
    expect(turnIsDroppable(semEfeito)).toBe(true)
  })

  it('pedido gravado, card, transferência ou marcador com efeito: nunca', () => {
    expect(turnIsDroppable({ ...semEfeito, wroteSomething: true })).toBe(false)
    expect(turnIsDroppable({ ...semEfeito, hasOrder: true })).toBe(false)
    expect(turnIsDroppable({ ...semEfeito, handoff: true })).toBe(false)
    expect(turnIsDroppable({ ...semEfeito, consequentialDirective: true })).toBe(false)
  })
})

describe('staleReplyDecision', () => {
  it('caso Bruna Teste: "vai demorar muito?" chegou 6 s depois da leitura → descarta e regenera', () => {
    expect(
      staleReplyDecision({
        snapshotAt: leitura,
        newest: { senderType: 'customer', createdAt: '2026-09-15T11:00:06.000Z' },
        droppable: true,
        dropsIncludingThis: 1,
      }),
    ).toBe('drop_regenerate')
  })

  it('nada novo depois da leitura → manda', () => {
    expect(staleReplyDecision({ snapshotAt: leitura, newest: null, droppable: true, dropsIncludingThis: 1 })).toBe('send')
    expect(
      staleReplyDecision({
        snapshotAt: leitura,
        newest: { senderType: 'customer', createdAt: '2026-09-15T10:59:50.000Z' },
        droppable: true,
        dropsIncludingThis: 1,
      }),
    ).toBe('send')
  })

  it('turno com efeito → manda mesmo com mensagem nova', () => {
    expect(
      staleReplyDecision({
        snapshotAt: leitura,
        newest: { senderType: 'customer', createdAt: '2026-09-15T11:00:06.000Z' },
        droppable: false,
        dropsIncludingThis: 1,
      }),
    ).toBe('send')
  })

  it('atendente escreveu no meio → não manda e ninguém regenera', () => {
    expect(
      staleReplyDecision({
        snapshotAt: leitura,
        newest: { senderType: 'agent', createdAt: '2026-09-15T11:00:06.000Z' },
        droppable: true,
      }),
    ).toBe('drop_quiet')
  })

  it(`freio: até ${MAX_STALE_DROPS} descartes seguidos; depois manda`, () => {
    const base = {
      snapshotAt: leitura,
      newest: { senderType: 'customer', createdAt: '2026-09-15T11:00:06.000Z' },
      droppable: true,
    }
    expect(staleReplyDecision({ ...base, dropsIncludingThis: MAX_STALE_DROPS })).toBe('drop_regenerate')
    expect(staleReplyDecision({ ...base, dropsIncludingThis: MAX_STALE_DROPS + 1 })).toBe('send')
  })

  it('Redis fora (sem contador) → manda, como antes', () => {
    expect(
      staleReplyDecision({
        snapshotAt: leitura,
        newest: { senderType: 'customer', createdAt: '2026-09-15T11:00:06.000Z' },
        droppable: true,
        dropsIncludingThis: undefined,
      }),
    ).toBe('send')
  })
})
