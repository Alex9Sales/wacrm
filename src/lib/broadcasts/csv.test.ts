import { describe, expect, it } from 'vitest'

import { namelessContactsWarning, parseCsv, summarizeCsvNames } from './csv'

// 15/09 (GoLink): a planilha colada só tinha telefones → 17 contatos sem nome.
describe('summarizeCsvNames', () => {
  it('conta as linhas sem nome (só telefones)', () => {
    const rows = parseCsv('67999990001\n67999990002\n67999990003')
    expect(summarizeCsvNames(rows)).toEqual({
      total: 3,
      withoutName: 3,
      phonesWithoutName: ['67999990001', '67999990002', '67999990003'],
    })
  })

  it('telefone,nome sem cabeçalho: só as linhas com nome vazio contam', () => {
    const rows = parseCsv('67999990001,Flash Baterias\n67999990002,\n67999990003;Piso Decor')
    const s = summarizeCsvNames(rows)
    expect(s.total).toBe(3)
    expect(s.withoutName).toBe(1)
    expect(s.phonesWithoutName).toEqual(['67999990002'])
  })

  it('cabeçalho sem coluna de nome: todas sem nome', () => {
    const rows = parseCsv('telefone,cidade\n67999990001,Campo Grande\n67999990002,Dourados')
    expect(summarizeCsvNames(rows).withoutName).toBe(2)
  })

  it('número repetido conta uma vez, e a 1ª linha manda (igual à importação)', () => {
    const rows = parseCsv('nome,telefone\n,+55 67 99999-0001\nVidro e Cia,67999990001\nAna,67999990002')
    const s = summarizeCsvNames(rows)
    expect(s.total).toBe(2)
    expect(s.withoutName).toBe(1)
  })

  it('nome só com espaços é sem nome', () => {
    expect(summarizeCsvNames([{ phone: '67999990001', name: '   ' }]).withoutName).toBe(1)
  })

  it('planilha vazia', () => {
    expect(summarizeCsvNames([])).toEqual({ total: 0, withoutName: 0, phonesWithoutName: [] })
  })
})

describe('namelessContactsWarning', () => {
  it('sem ninguém sem nome: sem aviso', () => {
    expect(namelessContactsWarning(0)).toBeNull()
  })

  it('plural e singular', () => {
    expect(namelessContactsWarning(17)).toBe(
      '17 contatos vão ficar sem nome — a busca por nome não vai achá-los. Cole a planilha com telefone e nome.',
    )
    expect(namelessContactsWarning(1)).toBe(
      '1 contato vai ficar sem nome — a busca por nome não vai achá-lo. Cole a planilha com telefone e nome.',
    )
  })

  it('quando não deu pra conferir quem já é contato: "Até N"', () => {
    expect(namelessContactsWarning(5, { approx: true })).toMatch(/^Até 5 contatos vão ficar sem nome/)
  })
})
