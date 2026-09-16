import { describe, expect, it } from 'vitest'

import { isAiPause, pauseAfterSettle, pauseSourceLabel } from './pause-rules'

const ia = { paused: true, pausedSource: 'ai', pausedReason: 'Cliente pediu acordo/parcelamento' }
const equipe = { paused: true, pausedSource: 'human', pausedReason: 'Não cobrar: cliente parceiro' }

describe('pauseAfterSettle — a pausa da IA sai quando ele quita; a da equipe fica', () => {
  it('Guincho Ribeiro (16/09): IA pausou por "acordo", ele pagou tudo → sai', () => {
    expect(pauseAfterSettle(ia, { firstSettle: true, stillOwes: false, asaasOpen: 0 })).toBe('lift')
  })

  it('pagou a vencida mas ainda tem parcela A VENCER no Asaas → pausa da IA fica (com nota)', () => {
    expect(pauseAfterSettle(ia, { firstSettle: true, stillOwes: false, asaasOpen: 2 })).toBe('keep_owes')
  })

  it('Asaas fora do ar na hora → pausa da IA fica, sem nota (continua visível no painel)', () => {
    expect(pauseAfterSettle(ia, { firstSettle: true, stillOwes: false, asaasOpen: null })).toBe('none')
  })

  it('pausa da equipe nunca some sozinha', () => {
    expect(pauseAfterSettle(equipe, { firstSettle: true, stillOwes: false })).toBe('keep_human')
    expect(pauseAfterSettle({ paused: true, pausedSource: 'revert', pausedReason: 'Cobrança marcada como errada' }, { firstSettle: true, stillOwes: false })).toBe('keep_human')
  })

  it('ainda deve, não é o 1º pagamento, ou não está pausado → nada', () => {
    expect(pauseAfterSettle(ia, { firstSettle: true, stillOwes: true })).toBe('none')
    expect(pauseAfterSettle(ia, { firstSettle: false, stillOwes: false })).toBe('none')
    expect(pauseAfterSettle({ ...ia, paused: false }, { firstSettle: true, stillOwes: false })).toBe('none')
    expect(pauseAfterSettle(null, { firstSettle: true, stillOwes: false })).toBe('none')
  })

  it('linha antiga (sem origem, antes da migração 0177): decide pelo motivo', () => {
    expect(pauseAfterSettle({ paused: true, pausedSource: null, pausedReason: 'Cliente contesta a cobrança' }, { firstSettle: true, stillOwes: false, asaasOpen: 0 })).toBe('lift')
    expect(pauseAfterSettle({ paused: true, pausedSource: null, pausedReason: 'não cobrar' }, { firstSettle: true, stillOwes: false })).toBe('keep_human')
  })

  it('motivo igual ao da IA mas gravado pela equipe continua da equipe', () => {
    expect(isAiPause({ pausedSource: 'human', pausedReason: 'Cliente pediu acordo/parcelamento' })).toBe(false)
  })
})

describe('pauseSourceLabel', () => {
  it('diz quem parou', () => {
    expect(pauseSourceLabel('ai', null)).toBe('pela IA')
    expect(pauseSourceLabel(null, 'Cliente contesta a cobrança')).toBe('pela IA')
    expect(pauseSourceLabel('human', 'x')).toBe('pela equipe')
    expect(pauseSourceLabel('revert', null)).toBe('ao marcar a cobrança como errada')
  })
})
