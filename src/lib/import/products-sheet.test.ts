import { describe, expect, it } from 'vitest'

import { mapProductRows } from './products-sheet'
import { parseCsv } from './sheet'

// Importação do catálogo (02/10/2026): preço no formato BR; preço que não é
// número fica de fora com a linha apontada — nunca entra a R$ 0 calado.

describe('mapProductRows — planilha do catálogo', () => {
  it('lê preço BR, "R$", "reais", ponto decimal e célula numérica', () => {
    const rows = parseCsv(
      [
        'Nome do produto;Preço;Descrição;Tipo',
        'Item A;1.028,67;Desc A;Produto',
        'Item B;R$ 1.028,67;;Serviço',
        'Item C;1.028;;',
        'Item D;1028.67;;',
        'Item E;1500 reais;;',
        'Item F;;;',
      ].join('\n'),
    )
    const { items, errors } = mapProductRows(rows)
    expect(errors).toEqual([])
    expect(items).toEqual([
      { name: 'Item A', description: 'Desc A', unitPrice: 1028.67, kind: 'product' },
      { name: 'Item B', description: null, unitPrice: 1028.67, kind: 'service' },
      { name: 'Item C', description: null, unitPrice: 1028, kind: 'product' },
      { name: 'Item D', description: null, unitPrice: 1028.67, kind: 'product' },
      { name: 'Item E', description: null, unitPrice: 1500, kind: 'product' },
      // preço vazio continua R$ 0, como sempre
      { name: 'Item F', description: null, unitPrice: 0, kind: 'product' },
    ])
  })

  it('preço inválido: item fica de fora e o erro aponta a linha da planilha', () => {
    const rows = parseCsv(
      ['Nome;Valor', 'Item A;10', 'Item B;a combinar', ';lixo sem nome', 'Item C;2x50'].join('\n'),
    )
    const { items, errors } = mapProductRows(rows)
    expect(items.map((i) => i.name)).toEqual(['Item A'])
    expect(errors).toEqual([
      { line: 3, label: 'Item B', raw: 'a combinar' },
      // linha sem nome é pulada como sempre — não vira erro de preço
      { line: 5, label: 'Item C', raw: '2x50' },
    ])
  })

  it('XLSX com preço numérico passa direto', () => {
    const rows = [{ Nome: 'Item A', Preço: 120.5 }]
    expect(mapProductRows(rows).items[0].unitPrice).toBe(120.5)
  })

  it('sem coluna de nome ou planilha vazia → nada', () => {
    expect(mapProductRows([])).toEqual({ items: [], errors: [] })
    expect(mapProductRows([{ Preço: '10' }])).toEqual({ items: [], errors: [] })
  })

  it('sem coluna de preço → tudo a R$ 0, sem erro', () => {
    const { items, errors } = mapProductRows([{ Produto: 'Item A' }])
    expect(errors).toEqual([])
    expect(items[0].unitPrice).toBe(0)
  })
})
