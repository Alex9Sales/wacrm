import { describe, expect, it } from 'vitest'

import { decideConnection, decideCustomerHome, type ConnectionHistoryRow, type ConnectionLite } from './connection-pick'

// GoLink (15/09): 'Asaas' nasceu 33 s antes da 'AsaasGoLink'. O label em ordem
// alfabética daria o mesmo resultado — por isso a 'Zeta' abaixo nasce primeiro.
const ASAAS: ConnectionLite = { id: 'c-asaas', label: 'Asaas', environment: 'production', createdAt: '2026-09-10T00:18:57Z' }
const GOLINK: ConnectionLite = { id: 'c-golink', label: 'AsaasGoLink', environment: 'production', createdAt: '2026-09-10T00:19:30Z' }

const hist = (conn: ConnectionLite, lastAt: string | null, charges = 1, enabled = true): ConnectionHistoryRow => ({
  connectionId: conn.id,
  label: conn.label,
  enabled,
  environment: conn.environment,
  charges,
  lastAt,
})

describe('decideConnection — a conta segue o cliente', () => {
  it('pedida e ligada → requested (mesmo com histórico noutra)', () => {
    const d = decideConnection({ enabled: [ASAAS, GOLINK], history: [hist(GOLINK, '2026-09-11')], requestedId: ASAAS.id })
    expect(d.conn?.id).toBe(ASAAS.id)
    expect(d.source).toBe('requested')
  })

  it('pedida e desligada (ou de outra conta) → none, sem cair noutra em silêncio', () => {
    const d = decideConnection({ enabled: [ASAAS], history: [], requestedId: 'c-desligada' })
    expect(d.conn).toBeNull()
    expect(d.source).toBe('none')
  })

  it('uma conexão só → only, mesmo com histórico em outra', () => {
    const d = decideConnection({ enabled: [ASAAS], history: [hist(GOLINK, '2026-09-11', 5, false)] })
    expect(d.conn?.id).toBe(ASAAS.id)
    expect(d.source).toBe('only')
  })

  it('nenhuma ligada → none', () => {
    expect(decideConnection({ enabled: [], history: [] }).source).toBe('none')
  })

  it('histórico na mais recente ligada → history', () => {
    const d = decideConnection({
      enabled: [ASAAS, GOLINK],
      history: [hist(ASAAS, '2026-06-01', 3), hist(GOLINK, '2026-09-11', 1)],
    })
    expect(d.conn?.id).toBe(GOLINK.id)
    expect(d.source).toBe('history')
    expect(d.historyLabels).toEqual(['AsaasGoLink', 'Asaas'])
    expect(d.disabledHomeLabel).toBeUndefined()
  })

  it('empate de data → a com mais cobranças', () => {
    const d = decideConnection({
      enabled: [ASAAS, GOLINK],
      history: [hist(ASAAS, '2026-09-11', 1), hist(GOLINK, '2026-09-11', 4)],
    })
    expect(d.conn?.id).toBe(GOLINK.id)
  })

  it('a mais recente está desligada → a mais recente LIGADA', () => {
    const OFF: ConnectionLite = { id: 'c-off', label: 'Antiga', environment: 'production', createdAt: '2026-01-01T00:00:00Z' }
    const d = decideConnection({
      enabled: [ASAAS, GOLINK],
      history: [hist(OFF, '2026-09-12', 9, false), hist(GOLINK, '2026-08-01', 1)],
    })
    expect(d.conn?.id).toBe(GOLINK.id)
    expect(d.source).toBe('history')
  })

  it('histórico só em desligada → default (1ª por createdAt) + disabledHomeLabel', () => {
    const OFF: ConnectionLite = { id: 'c-off', label: 'Antiga', environment: 'production', createdAt: '2026-01-01T00:00:00Z' }
    const d = decideConnection({ enabled: [GOLINK, ASAAS], history: [hist(OFF, '2026-09-12', 2, false)] })
    expect(d.conn?.id).toBe(ASAAS.id)
    expect(d.source).toBe('default')
    expect(d.disabledHomeLabel).toBe('Antiga')
  })

  it('sem histórico → default = 1ª por createdAt, NÃO por label', () => {
    const ZETA: ConnectionLite = { id: 'c-zeta', label: 'Zeta', environment: 'production', createdAt: '2026-01-01T00:00:00Z' }
    const d = decideConnection({ enabled: [ASAAS, GOLINK, ZETA], history: [] })
    expect(d.conn?.id).toBe('c-zeta')
    expect(d.source).toBe('default')
    expect(d.historyLabels).toEqual([])
  })
})

describe('decideCustomerHome — cliente não existe na conta escolhida', () => {
  const A = { id: 'c-asaas', label: 'Asaas' }
  const G = { id: 'c-golink', label: 'AsaasGoLink' }

  it('0 candidatos → create', () => {
    expect(decideCustomerHome({ explicit: true, candidates: [] })).toBe('create')
    expect(decideCustomerHome({ explicit: false, candidates: [] })).toBe('create')
  })

  it('1 candidato + escolhida por gente → refuse com id/label', () => {
    expect(decideCustomerHome({ explicit: true, candidates: [G] })).toEqual({ refuse: { id: 'c-golink', label: 'AsaasGoLink' } })
  })

  it('1 candidato + ninguém escolheu → switch', () => {
    expect(decideCustomerHome({ explicit: false, candidates: [{ ...G, lastAt: '2026-09-11', charges: 2 }] })).toEqual({
      switch: { id: 'c-golink', label: 'AsaasGoLink' },
    })
  })

  it('2 candidatos + ninguém escolheu → ambiguous (mais recente primeiro)', () => {
    expect(
      decideCustomerHome({ explicit: false, candidates: [{ ...A, lastAt: '2026-05-01' }, { ...G, lastAt: '2026-09-11' }] }),
    ).toEqual({ ambiguous: ['AsaasGoLink', 'Asaas'] })
  })

  it('2 candidatos + escolhida por gente → refuse com a de histórico mais recente', () => {
    expect(
      decideCustomerHome({ explicit: true, candidates: [{ ...A, lastAt: '2026-05-01' }, { ...G, lastAt: '2026-09-11' }] }),
    ).toEqual({ refuse: { id: 'c-golink', label: 'AsaasGoLink' } })
  })

  it('a mesma conta repetida conta uma vez só', () => {
    expect(decideCustomerHome({ explicit: false, candidates: [G, { ...G }] })).toEqual({ switch: G })
  })
})


describe('decideConnection — ambiente (revisão 15/09)', () => {
  it('histórico só no sandbox não decide quando há produção ligada', () => {
    const prod = { id: 'p', label: 'Produção', environment: 'production', createdAt: '2026-09-01T00:00:00Z' }
    const sand = { id: 's', label: 'Teste', environment: 'sandbox', createdAt: '2026-09-02T00:00:00Z' }
    const out = decideConnection({
      enabled: [prod, sand],
      history: [{ connectionId: 's', label: 'Teste', enabled: true, environment: 'sandbox', charges: 3, lastAt: '2026-09-10' }],
    })
    expect(out.source).toBe('default')
    expect(out.conn?.id).toBe('p')
  })
})
