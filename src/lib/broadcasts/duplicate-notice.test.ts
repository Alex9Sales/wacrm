import { describe, expect, it } from 'vitest'

import { allDuplicatesError, duplicateSkipNotice } from './duplicate-notice'

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

// Revisão 15/09: o aviso diz o que bateu — no WhatsApp o texto decide, então
// "esta mensagem" enganava quem trocou a imagem e manteve a legenda.
describe('duplicateSkipNotice — por motivo', () => {
  it('mesmo texto/legenda', () => {
    expect(
      duplicateSkipNotice([
        { name: 'Flash Baterias', reason: 'same_text' },
        { name: 'Piso Decor', reason: 'same_text' },
      ]),
    ).toBe('2 contatos já tinham recebido o mesmo texto/legenda hoje e ficaram de fora: Flash Baterias, Piso Decor.')
  })

  it('mesmos arquivos', () => {
    expect(duplicateSkipNotice([{ name: 'Vidro e Cia', reason: 'same_files' }])).toBe(
      '1 contato já tinha recebido os mesmos arquivos hoje e ficou de fora: Vidro e Cia.',
    )
  })

  it('mesmo template com os mesmos valores', () => {
    expect(duplicateSkipNotice([{ name: 'A', reason: 'same_template' }, { name: null, reason: 'same_template' }])).toBe(
      '2 contatos já tinham recebido o mesmo template com os mesmos valores hoje e ficaram de fora: A e mais 1.',
    )
  })

  it('motivos misturados: uma frase por motivo, na ordem texto → arquivos → template', () => {
    expect(
      duplicateSkipNotice([
        { name: 'C', reason: 'same_files' },
        { name: 'A', reason: 'same_text' },
        { name: 'B', reason: 'same_text' },
      ]),
    ).toBe(
      '2 contatos já tinham recebido o mesmo texto/legenda hoje e ficaram de fora: A, B. ' +
        '1 contato já tinha recebido os mesmos arquivos hoje e ficou de fora: C.',
    )
  })
})

describe('allDuplicatesError', () => {
  it('já receberam (com ou sem motivo)', () => {
    expect(allDuplicatesError([{}, {}, {}])).toBe('Todos os 3 contatos já receberam esta mensagem nas últimas 24 h.')
    expect(allDuplicatesError([{ reason: 'same_text' }])).toBe('Este contato já recebeu esta mensagem nas últimas 24 h.')
  })
})
