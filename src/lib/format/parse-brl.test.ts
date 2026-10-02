import { describe, it, expect } from 'vitest'
import { parseBrl, parseBrlField, formatBrlInput } from './parse-brl'

describe('parseBrl — valor em reais digitado/colado', () => {
  it.each([
    // vírgula = decimal, ponto = milhar (o print do Rafael: "1.028,67")
    ['1.028,67', 1028.67],
    ['1028,67', 1028.67],
    ['1.234.567,89', 1234567.89],
    ['2,5', 2.5],
    ['1.000,00', 1000],
    ['0,99', 0.99],
    // sem vírgula: ponto só é milhar quando tem cara de milhar
    ['1.028', 1028],
    [' 2.500 ', 2500],
    ['1.234.567', 1234567],
    ['10.5', 10.5],
    ['1028.67', 1028.67],
    ['0.500', 0.5],
    ['1.5000', 1.5],
    // inteiro puro
    ['1028', 1028],
    ['0', 0],
    // R$ na frente, espaço normal e o espaço inseparável do Intl
    ['R$ 1.028,67', 1028.67],
    ['R$1.028,67', 1028.67],
    ['r$ 10', 10],
    ['R$ 1.028,67', 1028.67],
    ['1 028,67', 1028.67],
    // digitando no meio do caminho
    ['5,', 5],
    [',5', 0.5],
    ['5.', 5],
    // negativo
    ['-10,5', -10.5],
    ['-R$ 1.028,67', -1028.67],
    ['R$ -10', -10],
    // formato americano só quando não há leitura brasileira válida
    ['1,028.67', 1028.67],
    ['1,234,567', 1234567],
  ])('%j → %s', (input, expected) => {
    expect(parseBrl(input)).toBe(expected)
  })

  it('"-0,00" vira 0 (sem -0)', () => {
    expect(Object.is(parseBrl('-0,00'), 0)).toBe(true)
  })

  it.each(['', '   ', '-', 'R$', 'R$ ', null, undefined])('vazio %j → null', (input) => {
    expect(parseBrl(input)).toBeNull()
  })

  it.each([
    'abc',
    '10 reais',
    '1.02,5', // ponto antes da vírgula fora do padrão de milhar
    '0.500,00', // milhar não começa com zero
    '1,2,3',
    '1.2.3',
    '10.50.3',
    ',',
    '.',
    '1e5',
    '--10',
    '12,3a',
    '1,028.67.5',
  ])('inválido %j → null', (input) => {
    expect(parseBrl(input)).toBeNull()
  })

  it('número já numérico passa direto; NaN/Infinity viram null', () => {
    expect(parseBrl(1028.67)).toBe(1028.67)
    expect(parseBrl(0)).toBe(0)
    expect(parseBrl(Number.NaN)).toBeNull()
    expect(parseBrl(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('parseBrlField — vazio × inválido', () => {
  it('vazio não é inválido (o campo decide se vale 0 ou null)', () => {
    expect(parseBrlField('')).toEqual({ value: null, invalid: false })
    expect(parseBrlField('  ')).toEqual({ value: null, invalid: false })
    expect(parseBrlField('-')).toEqual({ value: null, invalid: false })
    expect(parseBrlField('R$ ')).toEqual({ value: null, invalid: false })
    expect(parseBrlField(null)).toEqual({ value: null, invalid: false })
  })

  it('texto que não é número é inválido (a tela avisa em vez de gravar 0)', () => {
    expect(parseBrlField('abc')).toEqual({ value: null, invalid: true })
    expect(parseBrlField('1.02,5')).toEqual({ value: null, invalid: true })
  })

  it('valor válido', () => {
    expect(parseBrlField('1.028,67')).toEqual({ value: 1028.67, invalid: false })
  })
})

describe('formatBrlInput — o que o campo mostra ao sair', () => {
  it('dinheiro com 2 casas, milhar com ponto', () => {
    expect(formatBrlInput(1028.67)).toBe('1.028,67')
    expect(formatBrlInput(1000)).toBe('1.000,00')
    expect(formatBrlInput(1234567.89)).toBe('1.234.567,89')
    expect(formatBrlInput(2.5)).toBe('2,50')
  })

  it('percentual sem casas obrigatórias', () => {
    expect(formatBrlInput(10, 0)).toBe('10')
    expect(formatBrlInput(12.5, 0)).toBe('12,5')
  })

  it('arredonda em 2 casas e não quebra com NaN', () => {
    expect(formatBrlInput(1.234)).toBe('1,23')
    expect(formatBrlInput(Number.NaN)).toBe('')
  })

  it('vai-e-volta: formatar e ler de novo dá o mesmo número', () => {
    for (const n of [0, 0.5, 2.5, 10, 999, 1000, 1028.67, 2500, 1234567.89, -1028.67]) {
      expect(parseBrl(formatBrlInput(n))).toBe(n)
      expect(parseBrl(formatBrlInput(n, 0))).toBe(n)
    }
  })
})
