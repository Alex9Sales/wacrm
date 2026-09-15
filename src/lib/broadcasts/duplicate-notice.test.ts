import { describe, expect, it } from 'vitest'

import { duplicateSkipNotice } from './duplicate-notice'

// 15/09 (GoLink): mesma imagem 2× pra Flash Baterias, Piso Decor e Vidro e Cia.
describe('duplicateSkipNotice', () => {
  it('ninguém pulado: sem aviso', () => {
    expect(duplicateSkipNotice([])).toBeNull()
  })

  it('lista os nomes', () => {
    expect(
      duplicateSkipNotice([{ name: 'Flash Baterias' }, { name: 'Piso Decor' }, { name: 'Vidro e Cia' }]),
    ).toBe(
      '3 contatos já tinham recebido esta mensagem hoje e ficaram de fora: Flash Baterias, Piso Decor, Vidro e Cia.',
    )
  })

  it('singular', () => {
    expect(duplicateSkipNotice([{ name: 'Dra. Andressa' }])).toBe(
      '1 contato já tinha recebido esta mensagem hoje e ficou de fora: Dra. Andressa.',
    )
  })

  it('até 5 nomes; o resto (e os sem nome) vira "e mais N"', () => {
    const skipped = [
      { name: 'A' },
      { name: 'B' },
      { name: null },
      { name: 'C' },
      { name: 'D' },
      { name: 'E' },
      { name: 'F' },
    ]
    expect(duplicateSkipNotice(skipped)).toBe(
      '7 contatos já tinham recebido esta mensagem hoje e ficaram de fora: A, B, C, D, E e mais 2.',
    )
  })

  it('todos sem nome: só a contagem', () => {
    expect(duplicateSkipNotice([{ name: null }, { name: ' ' }])).toBe(
      '2 contatos já tinham recebido esta mensagem hoje e ficaram de fora.',
    )
  })
})
