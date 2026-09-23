import { describe, expect, it } from 'vitest'

import { DELETED_STATUS, statusAfterVanish } from './vanished'

describe('o que a cobrança virou depois de sumir da carteira', () => {
  it('apagada no Asaas vira DELETED — não continua "vencida"', () => {
    expect(statusAfterVanish({ status: 'OVERDUE', deleted: true }, 'OVERDUE')).toBe(DELETED_STATUS)
  })

  it('paga vira o status real que o Asaas devolveu', () => {
    expect(statusAfterVanish({ status: 'RECEIVED', deleted: false }, 'OVERDUE')).toBe('RECEIVED')
    expect(statusAfterVanish({ status: 'refunded' }, 'OVERDUE')).toBe('REFUNDED')
  })

  it('status igual ao que já está gravado não gera escrita', () => {
    expect(statusAfterVanish({ status: 'RECEIVED' }, 'RECEIVED')).toBeNull()
    expect(statusAfterVanish({ status: 'received' }, 'RECEIVED')).toBeNull()
    expect(statusAfterVanish({ status: 'OVERDUE', deleted: true }, DELETED_STATUS)).toBeNull()
  })

  it('sem resposta do Asaas, o status fica como está — nada de inventar', () => {
    expect(statusAfterVanish(null, 'OVERDUE')).toBeNull()
    expect(statusAfterVanish({ status: '  ' }, 'OVERDUE')).toBeNull()
  })
})
