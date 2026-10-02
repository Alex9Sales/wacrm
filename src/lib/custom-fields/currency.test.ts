import { describe, expect, it } from 'vitest'

import {
  checkCurrencyValues,
  currencyInputToStored,
  currencyStoredToInput,
  currencyToStored,
  invalidCurrencyMessage,
} from './currency'

// Campo personalizado de moeda (02/10/2026): digita no formato BR, grava no
// formato de sempre ("1028.67" — o que o antigo type="number" gravava).

describe('currencyToStored — formato gravado', () => {
  it.each([
    [1028.67, '1028.67'],
    [1500, '1500'],
    [0.5, '0.50'],
    [1028.6, '1028.60'],
    [0, '0'],
    [-0, '0'],
    [-10.5, '-10.50'],
    [1.239, '1.24'],
    [1234567.89, '1234567.89'],
  ])('%s → %s', (n, esperado) => {
    expect(currencyToStored(n)).toBe(esperado)
  })
})

describe('currencyInputToStored — o que a pessoa digita', () => {
  it.each([
    ['1.028,67', '1028.67'],
    ['R$ 1.028,67', '1028.67'],
    ['R$\u00A01.028,67', '1028.67'], // espaço inseparável do Intl
    ['1028.67', '1028.67'],
    ['1028,67', '1028.67'],
    ['1.028', '1028'],
    ['2.500,00', '2500'],
    ['0,5', '0.50'],
    ['', ''],
    ['   ', ''],
    ['R$', ''],
  ])('%j → %j', (texto, esperado) => {
    expect(currencyInputToStored(texto)).toBe(esperado)
  })

  it('texto que não é número fica como digitado (o salvar recusa — nunca vira 0)', () => {
    expect(currencyInputToStored('a combinar')).toBe('a combinar')
    expect(currencyInputToStored('1.02,5')).toBe('1.02,5')
  })
})

describe('currencyStoredToInput — valor gravado abrindo no campo', () => {
  it('formato gravado (inclusive o do type="number" antigo) volta formatado e exato', () => {
    expect(currencyStoredToInput('1028.67')).toBe('1.028,67')
    expect(currencyStoredToInput('1500')).toBe('1.500,00')
    expect(currencyStoredToInput('0.50')).toBe('0,50')
    expect(currencyStoredToInput('1028.5')).toBe('1.028,50')
  })

  it('vai-e-volta digitar → gravar → abrir não muda o valor', () => {
    for (const digitado of ['1.028,67', '0,99', '1.234.567,89', '10', '0,5']) {
      const gravado = currencyInputToStored(digitado)
      const aberto = currencyStoredToInput(gravado)
      expect(currencyInputToStored(aberto)).toBe(gravado)
    }
  })

  it('valor antigo gravado em texto livre continua abrindo', () => {
    expect(currencyStoredToInput('R$ 1.028,67')).toBe('1.028,67')
    expect(currencyStoredToInput('a combinar')).toBe('a combinar')
    expect(currencyStoredToInput('De R$ 5.000 a R$ 10.000')).toBe('De R$ 5.000 a R$ 10.000')
    expect(currencyStoredToInput('')).toBe('')
    expect(currencyStoredToInput(null)).toBe('')
    expect(currencyStoredToInput(undefined)).toBe('')
  })
})

describe('checkCurrencyValues — conferência no salvar', () => {
  const campos = [
    { id: 'f-orc', name: 'Orçamento' },
    { id: 'f-ticket', name: 'Ticket médio' },
  ]

  it('valor novo entendido é gravado no formato de sempre', () => {
    const r = checkCurrencyValues(campos, { 'f-orc': 'R$ 1.028,67', 'f-cidade': 'Campo Grande' }, {})
    expect(r.invalidField).toBeNull()
    expect(r.values).toEqual({ 'f-orc': '1028.67', 'f-cidade': 'Campo Grande' })
  })

  it('valor novo que não é número trava com o nome do campo', () => {
    const r = checkCurrencyValues(campos, { 'f-orc': '1.028,67', 'f-ticket': 'uns mil' }, {})
    expect(r.invalidField).toBe('Ticket médio')
  })

  it('valor antigo intocado passa byte a byte, mesmo sem ser número', () => {
    const existentes = { 'f-orc': 'a combinar', 'f-ticket': '1028.5' }
    const r = checkCurrencyValues(
      campos,
      { 'f-orc': 'a combinar', 'f-ticket': '1028.5', 'f-cidade': 'Dourados' },
      existentes,
    )
    expect(r.invalidField).toBeNull()
    expect(r.values).toEqual({ 'f-orc': 'a combinar', 'f-ticket': '1028.5', 'f-cidade': 'Dourados' })
  })

  it('aba com bundle velho (type="number") manda "1028.67" e grava igual', () => {
    const r = checkCurrencyValues(campos, { 'f-orc': '1028.67' }, { 'f-orc': '900' })
    expect(r.values['f-orc']).toBe('1028.67')
  })

  it('vazio e só "R$" passam como vazio (quem chama apaga)', () => {
    const r = checkCurrencyValues(campos, { 'f-orc': '', 'f-ticket': 'R$' }, { 'f-orc': '10' })
    expect(r.invalidField).toBeNull()
    expect(r.values).toEqual({ 'f-orc': '', 'f-ticket': '' })
  })

  it('campo de moeda fora do que a tela mandou não é criado', () => {
    const r = checkCurrencyValues(campos, { 'f-cidade': 'Dourados' }, {})
    expect(r.values).toEqual({ 'f-cidade': 'Dourados' })
  })

  it('mensagem de erro aponta o campo e dá o exemplo', () => {
    expect(invalidCurrencyMessage('Orçamento')).toBe(
      'Não entendi o valor de "Orçamento". Use, por exemplo, 1.028,67.',
    )
  })
})
