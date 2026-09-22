import { describe, expect, it } from 'vitest'

import { mayCloseUnseen, mergePayments, overduePendingCutoff } from './overdue-pending'

// João/GoLink 21/09: 13 boletos do dia 20 seguiam PENDING no Asaas e eram
// invisíveis — nem régua, nem lembrete, nem banco.
describe('overduePendingCutoff — "já venceu" é até ontem, no dia da conta', () => {
  it('ontem', () => {
    expect(overduePendingCutoff('2026-09-21')).toBe('2026-09-20')
    expect(overduePendingCutoff('2026-10-01')).toBe('2026-09-30')
    expect(overduePendingCutoff('2027-01-01')).toBe('2026-12-31')
  })
})

describe('mergePayments — sem repetir a mesma cobrança', () => {
  it('a listagem por status vence; a PENDING vencida só acrescenta o que faltava', () => {
    const primary = [{ id: 'a', status: 'OVERDUE' }, { id: 'b', status: 'OVERDUE' }]
    const extra = [{ id: 'b', status: 'PENDING' }, { id: 'c', status: 'PENDING' }]
    expect(mergePayments(primary, extra)).toEqual([
      { id: 'a', status: 'OVERDUE' },
      { id: 'b', status: 'OVERDUE' },
      { id: 'c', status: 'PENDING' },
    ])
  })

  it('listas vazias', () => {
    expect(mergePayments([], [])).toEqual([])
    expect(mergePayments([], [{ id: 'x' }])).toEqual([{ id: 'x' }])
  })
})

describe('mayCloseUnseen — o que pode ser fechado quando some da listagem', () => {
  const statuses = ['OVERDUE']

  it('status configurado: fecha (como sempre)', () => {
    expect(mayCloseUnseen({ status: 'OVERDUE', dueDate: '2026-09-01' }, statuses, '2026-09-20')).toBe(true)
    expect(mayCloseUnseen({ status: 'OVERDUE', dueDate: null }, statuses, null)).toBe(true)
  })

  it('PENDING vencida (até o corte) fecha — a listagem de vencidas PENDING rodou', () => {
    expect(mayCloseUnseen({ status: 'PENDING', dueDate: '2026-09-20' }, statuses, '2026-09-20')).toBe(true)
    expect(mayCloseUnseen({ status: 'PENDING', dueDate: '2026-09-01' }, statuses, '2026-09-20')).toBe(true)
  })

  it('PENDING com vencimento futuro (cobrança criada pelo CRM) NUNCA fecha por aqui', () => {
    expect(mayCloseUnseen({ status: 'PENDING', dueDate: '2026-09-21' }, statuses, '2026-09-20')).toBe(false)
    expect(mayCloseUnseen({ status: 'PENDING', dueDate: '2026-10-10' }, statuses, '2026-09-20')).toBe(false)
  })

  it('a listagem de PENDING vencida NÃO rodou (corte null): nada de PENDING fecha', () => {
    expect(mayCloseUnseen({ status: 'PENDING', dueDate: '2026-09-01' }, statuses, null)).toBe(false)
  })

  it('PENDING sem vencimento não fecha (não dá para saber se venceu)', () => {
    expect(mayCloseUnseen({ status: 'PENDING', dueDate: null }, statuses, '2026-09-20')).toBe(false)
  })

  it('outros status fora da configuração não fecham', () => {
    expect(mayCloseUnseen({ status: 'RECEIVED', dueDate: '2026-09-01' }, statuses, '2026-09-20')).toBe(false)
  })
})
