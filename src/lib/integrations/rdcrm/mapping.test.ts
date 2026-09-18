import { describe, it, expect } from 'vitest'
import {
  indexRdStages,
  localStageFor,
  lostReasonIdFor,
  phoneVariants,
  planRdUpdate,
  rdStageFor,
  rdStatusOf,
} from './mapping'

const RD = [
  {
    id: 'p1',
    name: '1. Cadência pré-vendas',
    deal_stages: [
      { id: 's1', name: 'Sem contato' },
      { id: 's2', name: '1ª Tentativa de Contato' },
    ],
  },
  {
    id: 'p2',
    name: '2. Comercial | Franquia',
    deal_stages: [
      { _id: 's3', name: 'NOVO LEAD' },
      { id: 's4', name: 'REUNIÃO AGENDADA' },
      { id: 's5', name: 'ENVIO DA COF' },
    ],
  },
]
const LOCAL = [
  { id: 'L1', name: '1. Cadência pré-vendas', stages: [{ id: 'l1', name: 'Sem contato' }] },
  {
    id: 'L2',
    name: '2. Comercial | Franquia',
    stages: [
      { id: 'l3', name: 'Novo lead' },
      { id: 'l4', name: 'Reunião agendada' },
      { id: 'l5', name: 'Envio da COF' },
    ],
  },
]

describe('mapa de funis e etapas', () => {
  const idx = indexRdStages(RD)
  it('matches stages by name ignoring case and accents, in both directions', () => {
    expect(rdStageFor(idx, '2. Comercial | Franquia', 'Reunião agendada')?.stageId).toBe('s4')
    expect(rdStageFor(idx, '2. comercial | franquia', 'novo lead')?.stageId).toBe('s3')
    expect(localStageFor(LOCAL, '2. Comercial | Franquia', 'ENVIO DA COF')?.stageId).toBe('l5')
  })
  it('funnel without a twin does not map', () => {
    expect(rdStageFor(idx, 'Funil de vendas', 'Novo lead')).toBeNull()
    expect(localStageFor(LOCAL, '5. Pós-venda | Franquia', 'ONBOARDING')).toBeNull()
  })
})

describe('rdStatusOf', () => {
  it('reads API win and webhook status', () => {
    expect(rdStatusOf({ win: null })).toBe('open')
    expect(rdStatusOf({ win: true })).toBe('won')
    expect(rdStatusOf({ win: false })).toBe('lost')
    expect(rdStatusOf({ status: 'ongoing' })).toBe('open')
    expect(rdStatusOf({ status: 'paused' })).toBe('open')
    expect(rdStatusOf({ status: 'lost' })).toBe('lost')
  })
})

describe('lostReasonIdFor', () => {
  const reasons = [
    { _id: 'r1', name: 'Lead interessado em serviço' },
    { _id: 'r9', name: 'Outros' },
  ]
  it('same name wins, otherwise "Outros"', () => {
    expect(lostReasonIdFor(reasons, 'lead interessado em servico')).toBe('r1')
    expect(lostReasonIdFor(reasons, 'Achou caro')).toBe('r9')
    expect(lostReasonIdFor([], 'x')).toBeNull()
  })
})

describe('phoneVariants', () => {
  it('builds the forms the RD search accepts', () => {
    expect(phoneVariants('5511900001234')).toEqual(['5511900001234', '+5511900001234', '11900001234'])
    expect(phoneVariants('123')).toEqual([])
  })
})

describe('planRdUpdate', () => {
  it('moves then closes an open deal', () => {
    expect(
      planRdUpdate({ want: { stageId: 's4', status: 'won', lostReasonId: null }, have: { stageId: 's1', status: 'open' } }),
    ).toEqual({ moveTo: 's4', close: 'won', blocked: null })
  })
  it('nothing to do when equal', () => {
    expect(
      planRdUpdate({ want: { stageId: 's1', status: 'open', lostReasonId: null }, have: { stageId: 's1', status: 'open' } }),
    ).toEqual({ moveTo: null, close: null, blocked: null })
  })
  it('a closed RD deal is never touched (API cannot reopen)', () => {
    const r = planRdUpdate({ want: { stageId: 's1', status: 'open', lostReasonId: null }, have: { stageId: 's1', status: 'lost' } })
    expect(r.moveTo).toBeNull()
    expect(r.close).toBeNull()
    expect(r.blocked).toMatch(/PERDIDO/)
  })
})
