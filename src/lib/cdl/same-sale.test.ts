import { describe, expect, it } from 'vitest'

import { isSameSale, planMerges, type SaleLike } from './same-sale'

const imp = (id: string, day: string, amount = 125): SaleLike => ({ id, source: 'import', amount, occurredAt: `${day}T12:00:00.000Z` })
const erp = (id: string, at: string, amount = 125): SaleLike => ({ id, source: 'erp', amount, occurredAt: at })
const deal = (id: string, at: string, amount = 125): SaleLike => ({ id, source: 'deal', amount, occurredAt: at })

describe('isSameSale — a mesma venda por caminhos diferentes', () => {
  it('planilha (só a data) × ERP no mesmo dia local, mesmo depois da meia-noite UTC (Miriam)', () => {
    expect(isSameSale(imp('i', '2026-06-08'), erp('e', '2026-06-09T00:25:39.666Z'))).toBe(true)
  })

  it('valor diferente não é a mesma venda (planilha × ERP é exato)', () => {
    expect(isSameSale(imp('i', '2026-06-08', 125), erp('e', '2026-06-08T15:00:00Z', 120))).toBe(false)
  })

  it('Ganho no funil tolera o desconto do caixa (até 10% ou R$ 5)', () => {
    expect(isSameSale(deal('d', '2026-06-08T18:00:00Z', 125), erp('e', '2026-06-08T15:00:00Z', 120))).toBe(true)
    expect(isSameSale(deal('d', '2026-06-08T18:00:00Z', 250), erp('e', '2026-06-08T15:00:00Z', 120))).toBe(false)
  })

  it('mesma fonte nunca se funde (duas vendas do ERP no mesmo dia são duas vendas)', () => {
    expect(isSameSale(erp('a', '2026-06-08T15:00:00Z'), erp('b', '2026-06-08T15:30:00Z'))).toBe(false)
  })

  it('mais de 36h = compra nova', () => {
    expect(isSameSale(imp('i', '2026-06-08'), erp('e', '2026-06-10T15:00:00Z'))).toBe(false)
  })
})

describe('planMerges — quem fica, quem some', () => {
  it('importação some dentro do ERP; o ERP fica', () => {
    const p = planMerges([imp('i1', '2026-05-03'), erp('e1', '2026-05-03T18:02:49Z'), imp('i2', '2026-06-08'), erp('e2', '2026-06-09T00:25:39Z')])
    expect(p.map((d) => `${d.merge.id}→${d.keep.id}`).sort()).toEqual(['i1→e1', 'i2→e2'])
  })

  it('duas vendas do ERP no mesmo dia e uma planilha: a planilha some numa delas, as duas do ERP ficam', () => {
    const p = planMerges([imp('i1', '2026-08-17'), erp('e1', '2026-08-17T13:48:22Z'), erp('e2', '2026-08-17T13:49:24Z')])
    expect(p).toHaveLength(1)
    expect(p[0].merge.id).toBe('i1')
  })

  it('o ERP manda: uma venda do ERP absorve TODAS as planilhas repetidas do dia', () => {
    const p = planMerges([erp('e1', '2026-08-24T14:00:00Z'), imp('i1', '2026-08-24'), imp('i2', '2026-08-24'), imp('i3', '2026-08-24')])
    expect(p.map((d) => d.merge.id).sort()).toEqual(['i1', 'i2', 'i3'])
    expect(p.every((d) => d.keep.id === 'e1')).toBe(true)
  })

  it('sem ERP, o Ganho no funil absorve só UMA planilha — a outra pode ser venda de verdade', () => {
    const p = planMerges([deal('d1', '2026-08-24T18:00:00Z'), imp('i1', '2026-08-24'), imp('i2', '2026-08-24')])
    expect(p).toHaveLength(1)
    expect(p[0].keep.id).toBe('d1')
  })

  it('negócio ganho some dentro do ERP; sem ERP, a planilha some dentro do negócio', () => {
    expect(planMerges([deal('d', '2026-06-08T18:00:00Z'), erp('e', '2026-06-08T15:00:00Z')])[0]).toMatchObject({ keep: { id: 'e' }, merge: { id: 'd' } })
    expect(planMerges([deal('d', '2026-06-08T18:00:00Z'), imp('i', '2026-06-08')])[0]).toMatchObject({ keep: { id: 'd' }, merge: { id: 'i' } })
  })

  it('sem par não mexe em nada', () => {
    expect(planMerges([imp('i', '2026-06-08'), erp('e', '2026-07-01T15:00:00Z')])).toEqual([])
  })
})
