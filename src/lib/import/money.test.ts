import { describe, expect, it } from 'vitest'

import { formatMoneyError, parseImportMoney, readMoneyColumn } from './money'
import { parseCsv } from './sheet'

// Dinheiro vindo de planilha (02/10/2026): mesma leitura BR do resto do
// sistema; o que não é número vira ERRO na prévia, nunca R$ 0 calado.

describe('parseImportMoney — célula de planilha', () => {
  it.each([
    // formato brasileiro (o caso do Rafael)
    ['1.028,67', 1028.67],
    ['R$ 1.028,67', 1028.67],
    ['R$ 1.028,67', 1028.67],
    ['1.028', 1028],
    ['1028.67', 1028.67],
    ['1.500,00', 1500],
    ['1.234.567,89', 1234567.89],
    ['120,50', 120.5],
    ['100', 100],
    ['-1.028,67', -1028.67],
    ['1 028,67', 1028.67],
    // o que o toPriceNum/toNum antigo aceitava e continua valendo
    ['1500 reais', 1500],
    ['1.500,00 reais', 1500],
    ['R$1.500', 1500],
    ['1500 R$', 1500],
    ['BRL 1.500,00', 1500],
    ['1.500,00 BRL', 1500],
    ['Rs 1500', 1500],
    ['1 real', 1],
    ['1500reais', 1500],
    // ...e o que ele lia ERRADO agora sai certo
    ['1,028.67', 1028.67],
  ])('%j → %s', (raw, esperado) => {
    expect(parseImportMoney(raw)).toEqual({ value: esperado, invalid: false })
  })

  it('célula numérica do XLSX passa direto', () => {
    expect(parseImportMoney(1028.67)).toEqual({ value: 1028.67, invalid: false })
    expect(parseImportMoney(0)).toEqual({ value: 0, invalid: false })
    expect(parseImportMoney(Number.NaN)).toEqual({ value: null, invalid: true })
  })

  it.each([[''], ['   '], ['-'], ['R$'], ['reais'], [null], [undefined]])(
    'vazio %j → sem valor, sem erro',
    (raw) => {
      expect(parseImportMoney(raw)).toEqual({ value: null, invalid: false })
    },
  )

  it.each([
    ['a combinar'],
    ['2x50'], // o antigo lia 250
    ['US$ 10'], // o antigo lia 10 — dólar não vira real calado
    ['1.000.00'],
    ['1.02,5'],
    ['10%'],
    ['R$ 1.500,00 à vista'],
    [true],
  ])('%j → inválido (erro na prévia, nunca 0)', (raw) => {
    expect(parseImportMoney(raw)).toEqual({ value: null, invalid: true })
  })
})

describe('readMoneyColumn — coluna inteira com a linha de cada erro', () => {
  const csv = [
    'Nome;Valor',
    'Item A;1.028,67',
    'Item B;a combinar',
    '',
    'Item C;',
    'Item D;1500 reais',
    'Item E;2x50',
  ].join('\n')

  it('lê cada linha e aponta a linha da planilha das inválidas', () => {
    const rows = parseCsv(csv)
    const { cells, errors } = readMoneyColumn(rows, 'Valor', (r) => String(r.Nome ?? ''))
    expect(cells.map((c) => c.value)).toEqual([1028.67, null, null, 1500, null])
    expect(cells.map((c) => c.invalid)).toEqual([false, true, false, false, true])
    expect(errors).toEqual([
      { line: 3, label: 'Item B', raw: 'a combinar' },
      { line: 7, label: 'Item E', raw: '2x50' },
    ])
  })

  it('sem coluna de valor: tudo vazio e nenhum erro', () => {
    const rows = parseCsv(csv)
    const { cells, errors } = readMoneyColumn(rows, undefined, () => '')
    expect(cells.every((c) => c.value === null && !c.invalid)).toBe(true)
    expect(errors).toEqual([])
  })

  it('formata o aviso da prévia', () => {
    expect(formatMoneyError({ line: 3, label: 'Item B', raw: 'a combinar' })).toBe(
      'Linha 3 · Item B: "a combinar"',
    )
    expect(formatMoneyError({ line: null, label: 'Item B', raw: 'x' })).toBe('Item B: "x"')
    expect(formatMoneyError({ line: 9, label: '', raw: 'x' })).toBe('Linha 9: "x"')
    expect(formatMoneyError({ line: null, label: '', raw: 'x' })).toBe(
      'Linha sem identificação: "x"',
    )
  })
})
