import { describe, expect, it } from 'vitest'

import { humanizeProduct, parseProductLabel, productNames } from './product-label'

describe('parseProductLabel', () => {
  it('ERP: quantidade decimal, marca repetida e dois espaços', () => {
    expect(parseProductLabel('1.00x P-13 UltraGaz  Ultragaz')).toEqual([{ qty: 1, name: 'P-13 Ultragaz' }])
    expect(parseProductLabel('2.00x P-13 Copagaz  Copagaz')).toEqual([{ qty: 2, name: 'P-13 Copagaz' }])
  })
  it('planilha: "1x" e marca repetida sem espaço duplo; ou sem quantidade', () => {
    expect(parseProductLabel('1x P-13 Copagaz Copagaz')).toEqual([{ qty: 1, name: 'P-13 Copagaz' }])
    expect(parseProductLabel('P-13 UltraGaz Ultragaz')).toEqual([{ qty: 1, name: 'P-13 Ultragaz' }])
    expect(parseProductLabel('1.00x P-13 Ultragaz')).toEqual([{ qty: 1, name: 'P-13 Ultragaz' }])
  })
  it('lista de itens', () => {
    expect(parseProductLabel('1.00x P-13 UltraGaz  Ultragaz, 1.00x Vasilamne P-13')).toEqual([
      { qty: 1, name: 'P-13 Ultragaz' },
      { qty: 1, name: 'Vasilamne P-13' },
    ])
  })
  it('vazio/nulo → nada', () => {
    expect(parseProductLabel(null)).toEqual([])
    expect(parseProductLabel('  ')).toEqual([])
  })
  it('não inventa: quantidade estranha vira 1 e nome desconhecido fica como está', () => {
    expect(parseProductLabel('0x Água 20L')).toEqual([{ qty: 1, name: 'Água 20L' }])
    expect(parseProductLabel('Água Mineral 20L')).toEqual([{ qty: 1, name: 'Água Mineral 20L' }])
  })
})

describe('humanizeProduct / productNames', () => {
  it('a frase que vai pro cliente', () => {
    expect(humanizeProduct('1.00x P-13 Copagaz  Copagaz')).toBe('P-13 Copagaz')
    expect(humanizeProduct('2.00x P-13 UltraGaz  Ultragaz')).toBe('2 P-13 Ultragaz')
    expect(humanizeProduct('1.50x Gás a granel')).toBe('1,5 Gás a granel')
    expect(humanizeProduct('1.00x P-13 UltraGaz  Ultragaz, 2x Vasilhame P-13')).toBe('P-13 Ultragaz e 2 Vasilhame P-13')
    expect(humanizeProduct(null)).toBe('seu pedido')
    expect(humanizeProduct('', 'o de sempre')).toBe('o de sempre')
  })
  it('só nomes, sem quantidade', () => {
    expect(productNames('2.00x P-13 UltraGaz  Ultragaz')).toBe('P-13 Ultragaz')
    expect(productNames('1x A, 2x B, 3x C')).toBe('A, B e C')
  })
})
