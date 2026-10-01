import { describe, it, expect } from 'vitest'
import type { RdDeal } from './client'
import {
  buildRdDealBody,
  indexRdStages,
  inheritFromRdDeal,
  isForeignRecordField,
  localStageFor,
  lostReasonIdFor,
  phoneVariants,
  planRdUpdate,
  rdLostNote,
  rdOriginNote,
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
  it('posição da etapa dentro do funil (sem `order`, vale a ordem da lista)', () => {
    expect(rdStageFor(idx, '2. Comercial | Franquia', 'Novo lead')?.position).toBe(0)
    expect(rdStageFor(idx, '2. Comercial | Franquia', 'Envio da COF')?.position).toBe(2)
    expect(rdStageFor(idx, '1. Cadência pré-vendas', '1ª Tentativa de Contato')?.position).toBe(1)
  })
  it('posição segue o `order` do RD mesmo com a lista fora de ordem', () => {
    const fora = indexRdStages([
      {
        id: 'p9',
        name: 'Funil',
        deal_stages: [
          { id: 'c', name: 'C', order: 3 },
          { id: 'a', name: 'A', order: 1 },
          { id: 'b', name: 'B', order: 2 },
        ],
      },
    ])
    expect(['a', 'b', 'c'].map((id) => fora.byStageId.get(id)?.position)).toEqual([0, 1, 2])
  })
})

describe('negócio novo herdando do negócio RD de origem', () => {
  const origem: RdDeal = {
    _id: 'd1',
    campaign: { _id: 'camp1', name: 'Campanha X' },
    campaign_id: 'camp1',
    deal_source: { _id: 'src1', name: 'Facebook Ads' },
    deal_source_id: 'src1',
    deal_custom_fields: [
      { custom_field_id: 'cf-cidade', value: 'Campinas', custom_field: { label: 'Cidade', slug: 'cidade' } },
      { custom_field_id: 'cf-invest', value: ['Acima de 50 mil'], custom_field: { label: 'Investimento', slug: 'investimento' } },
      { custom_field_id: 'cf-vazio', value: '  ', custom_field: { label: 'Observação', slug: 'obs' } },
      { custom_field_id: 'cf-lista-vazia', value: [], custom_field: { label: 'Interesses', slug: 'interesses' } },
      { custom_field_id: 'cf-nulo', value: null, custom_field: { label: 'Estado', slug: 'estado' } },
      { custom_field_id: 'cf-id', value: '98765', custom_field: { label: 'ID Solutto', slug: 'id_solutto' } },
      { custom_field_id: 'cf-cod', value: 'A-1', custom_field: { label: 'Código', slug: 'cod_x' } },
      { custom_field_id: 'cf-data', value: '2026-09-30', custom_field: { label: 'Data criação', slug: 'dt' } },
      {
        custom_field_id: 'cf-hist',
        value: '2026-09-30',
        custom_field: { label: 'Histórico data criação Solutto', slug: 'historico_data_criacao_solutto' },
      },
    ],
  }

  it('herda campanha, fonte e só os campos com valor que não identificam registro de outro sistema', () => {
    expect(inheritFromRdDeal(origem)).toEqual({
      campaignId: 'camp1',
      dealSourceId: 'src1',
      customFields: [
        { custom_field_id: 'cf-cidade', value: 'Campinas' },
        { custom_field_id: 'cf-invest', value: ['Acima de 50 mil'] },
      ],
    })
  })

  it('aceita campanha/fonte só como id solto, e negócio de origem ausente não herda nada', () => {
    expect(inheritFromRdDeal({ campaign_id: 'c9', deal_source_id: 's9' })).toEqual({
      campaignId: 'c9',
      dealSourceId: 's9',
      customFields: [],
    })
    expect(inheritFromRdDeal(null)).toEqual({ campaignId: null, dealSourceId: null, customFields: [] })
  })

  it('exclusões comparam rótulo E slug canônicos (sem acento, sem caixa, separador vira _)', () => {
    expect(isForeignRecordField({ label: 'ID SOLUTTO' })).toBe(true)
    expect(isForeignRecordField({ label: 'x', slug: 'id-solutto' })).toBe(true)
    expect(isForeignRecordField({ label: 'codigo' })).toBe(true)
    expect(isForeignRecordField({ label: 'Data de criação' })).toBe(false) // nome diferente: fica
    expect(isForeignRecordField({ label: 'Código do cupom' })).toBe(false)
    expect(isForeignRecordField(null)).toBe(false)
  })

  it('corpo do POST /deals: campaign e deal_source no TOPO, campos personalizados DENTRO de "deal"', () => {
    const body = buildRdDealBody({
      name: 'Fulana de Teste',
      stageId: 's3',
      ownerId: 'u1',
      inherit: inheritFromRdDeal(origem),
    })
    expect(body).toEqual({
      deal: {
        name: 'Fulana de Teste',
        deal_stage_id: 's3',
        user_id: 'u1',
        deal_custom_fields: [
          { custom_field_id: 'cf-cidade', value: 'Campinas' },
          { custom_field_id: 'cf-invest', value: ['Acima de 50 mil'] },
        ],
      },
      campaign: { _id: 'camp1' },
      deal_source: { _id: 'src1' },
    })
  })

  it('2ª tentativa (RD recusou) vai sem os campos; a 3ª, sem campanha/fonte também', () => {
    const inherit = inheritFromRdDeal(origem)
    const sem = buildRdDealBody({ name: 'Fulana', stageId: 's3', ownerId: null, inherit, withCustomFields: false })
    expect(sem).toEqual({ deal: { name: 'Fulana', deal_stage_id: 's3' }, campaign: { _id: 'camp1' }, deal_source: { _id: 'src1' } })
    const nada = buildRdDealBody({
      name: 'Fulana',
      stageId: 's3',
      ownerId: null,
      inherit,
      withCustomFields: false,
      withCampaign: false,
    })
    expect(nada).toEqual({ deal: { name: 'Fulana', deal_stage_id: 's3' } })
  })

  it('sem herança: o corpo de sempre, com o contato novo quando o lead não existe no RD', () => {
    expect(
      buildRdDealBody({
        name: 'A',
        stageId: 's1',
        ownerId: null,
        newContact: { email: 'a@exemplo.com', phone: '55 11 90000-0000' },
      }),
    ).toEqual({
      deal: { name: 'Lead A', deal_stage_id: 's1' },
      contacts: [
        {
          name: 'Lead A',
          emails: [{ email: 'a@exemplo.com' }],
          phones: [{ phone: '+5511900000000', type: 'cellphone' }],
        },
      ],
    })
  })
})

describe('rdOriginNote', () => {
  it('campanha · fonte, sem o que é genérico', () => {
    expect(rdOriginNote('Franquia Outubro', 'Facebook Ads')).toBe('Origem do lead (FluxiaCRM): Franquia Outubro · Facebook Ads')
    expect(rdOriginNote('unknown', 'Facebook Ads')).toBe('Origem do lead (FluxiaCRM): Facebook Ads')
    expect(rdOriginNote('Franquia Outubro', '(not set)')).toBe('Origem do lead (FluxiaCRM): Franquia Outubro')
  })
  it('nada útil → sem anotação; repetido entra uma vez', () => {
    expect(rdOriginNote('unknown / unknown', '')).toBeNull()
    expect(rdOriginNote(null, null)).toBeNull()
    expect(rdOriginNote('Instagram', 'instagram')).toBe('Origem do lead (FluxiaCRM): Instagram')
  })
})

describe('rdLostNote', () => {
  it('motivo igual ao do RD e sem comentário → "Via FluxiaCRM" (como sempre)', () => {
    expect(rdLostNote({ reason: 'Não respondeu', reasonMatchedExactly: true })).toBe('Via FluxiaCRM')
    expect(rdLostNote({ reason: '', reasonMatchedExactly: false, note: '  ' })).toBe('Via FluxiaCRM')
  })
  it('motivo que o RD não tem vai escrito; comentário vem depois', () => {
    expect(rdLostNote({ reason: 'Achou caro', reasonMatchedExactly: false })).toBe('Via FluxiaCRM — Achou caro')
    expect(rdLostNote({ reason: 'Achou caro', reasonMatchedExactly: false, note: 'volta a pensar em março' })).toBe(
      'Via FluxiaCRM — Achou caro — volta a pensar em março',
    )
  })
  it('motivo exato + comentário: só o comentário', () => {
    expect(rdLostNote({ reason: 'Não respondeu', reasonMatchedExactly: true, note: 'número fora do ar' })).toBe(
      'Via FluxiaCRM — número fora do ar',
    )
  })
  it('corta em 500', () => {
    const n = rdLostNote({ reason: 'x'.repeat(300), reasonMatchedExactly: false, note: 'y'.repeat(600) })
    expect(n.length).toBe(500)
    expect(n.startsWith(`Via FluxiaCRM — ${'x'.repeat(200)} — y`)).toBe(true)
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
    { _id: 'r2', name: 'Não respondeu' },
    { _id: 'r9', name: 'Outros' },
  ]
  it('same name wins, otherwise "Outros"', () => {
    expect(lostReasonIdFor(reasons, 'lead interessado em servico')).toBe('r1')
    expect(lostReasonIdFor(reasons, 'Achou caro')).toBe('r9')
    expect(lostReasonIdFor([], 'x')).toBeNull()
  })
  it('detail in parentheses (follow-up give-up) still matches the RD reason', () => {
    expect(lostReasonIdFor(reasons, 'Não respondeu (5 follow-ups)')).toBe('r2')
    expect(lostReasonIdFor(reasons, 'Achou caro (cliente)')).toBe('r9')
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
