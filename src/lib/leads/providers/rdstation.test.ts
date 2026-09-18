import { describe, it, expect } from 'vitest'

import { parseRdWebhook, mapRdLead, rdOriginLabel, pickIntroForOrigin } from './rdstation'

// Pacote no formato que o RD documenta hoje (o próprio RD avisa que vai mudar).
const LEAD = {
  id: '100000001',
  email: 'carla@exemplo.com',
  name: 'Carla Teste',
  company: null,
  job_title: 'Analista',
  public_url: 'http://rdstation.com.br/leads/public/00000000',
  created_at: '2026-09-16T17:57:10.189-03:00',
  opportunity: 'true',
  number_conversions: '3',
  mobile_phone: '+55 11 99000-1234',
  personal_phone: '+55 11 3333-3333',
  city: 'São Paulo',
  estado: 'SP',
  tags: ['franquia', 'sp'],
  first_conversion: {
    created_at: '2026-09-10T10:00:00-03:00',
    content: { identificador: 'LP Seja um Franqueado' },
  },
  last_conversion: {
    created_at: '2026-09-16T17:57:00-03:00',
    content: { identificador: 'Formulário Contato' },
  },
  custom_fields: {
    'Quanto pretende investir?': 'R$ 40.000',
    'Quando pretende começar?': 'Imediatamente',
  },
}

describe('parseRdWebhook', () => {
  it('lê o formato documentado {leads:[…]}', () => {
    const out = parseRdWebhook({ leads: [LEAD] })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Carla Teste')
    expect(out[0].email).toBe('carla@exemplo.com')
  })

  it('aguenta os formatos que o RD ainda pode mandar', () => {
    expect(parseRdWebhook([LEAD])).toHaveLength(1)
    expect(parseRdWebhook({ lead: LEAD })).toHaveLength(1)
    expect(parseRdWebhook(LEAD)).toHaveLength(1)
  })

  it('não quebra com lixo', () => {
    expect(parseRdWebhook(null)).toEqual([])
    expect(parseRdWebhook({})).toEqual([])
    expect(parseRdWebhook({ leads: [null, 'x', 42] })).toEqual([])
    expect(parseRdWebhook('texto')).toEqual([])
  })
})

describe('mapRdLead', () => {
  it('prefere o celular ao fixo (é o que tem WhatsApp)', () => {
    expect(mapRdLead(LEAD)?.phone).toBe('+55 11 99000-1234')
  })

  it('cai no fixo quando não há celular', () => {
    expect(mapRdLead({ ...LEAD, mobile_phone: '' })?.phone).toBe('+55 11 3333-3333')
  })

  it('traz os campos personalizados (é a qualificação do formulário)', () => {
    const f = mapRdLead(LEAD)!.fields
    expect(f['quanto pretende investir?']).toBe('R$ 40.000')
    expect(f['quando pretende começar?']).toBe('Imediatamente')
    expect(f.city).toBe('São Paulo')
    expect(f.estado).toBe('SP')
  })

  it('guarda a origem — a IA não precisa perguntar de onde a pessoa veio', () => {
    const m = mapRdLead(LEAD)!.meta
    expect(m['Primeira conversão']).toBe('LP Seja um Franqueado')
    expect(m['Última conversão']).toBe('Formulário Contato')
    expect(m['Tags no RD']).toBe('franquia, sp')
    expect(m['Conversões']).toBe('3')
  })

  it('não repete a conversão quando primeira e última são a mesma', () => {
    const same = { ...LEAD, last_conversion: LEAD.first_conversion }
    const m = mapRdLead(same)!.meta
    expect(m['Primeira conversão']).toBe('LP Seja um Franqueado')
    expect(m['Última conversão']).toBeUndefined()
  })

  it('descarta lead sem nada que identifique', () => {
    expect(mapRdLead({ opportunity: 'false' })).toBeNull()
  })

  it('a origem do card é a conversão mais recente', () => {
    expect(rdOriginLabel(mapRdLead(LEAD)!)).toBe('Formulário Contato')
    expect(rdOriginLabel(mapRdLead({ ...LEAD, first_conversion: null, last_conversion: null })!)).toBe('RD Station')
  })

  // Zelo 18/09: o RD registra "Negociação criada no RD Station CRM" como
  // conversão quando a integração cria o negócio — isso não é campanha.
  it('ignora a conversão sintética "Negociação criada no RD" na origem', () => {
    const lead = mapRdLead({
      ...LEAD,
      first_conversion: { content: { identificador: 'solicite-um-orcamento' } },
      last_conversion: { content: { identificador: 'Negociação criada no RD Station CRM' } },
    })!
    expect(rdOriginLabel(lead)).toBe('solicite-um-orcamento')
  })

  it('guarda a campanha do anúncio (conversion_origin) quando o RD manda', () => {
    const m = mapRdLead({
      ...LEAD,
      last_conversion: {
        content: { identificador: 'Formulário Contato' },
        conversion_origin: { source: 'facebook', medium: 'cpc', campaign: 'franquia-setembro' },
      },
    })!.meta
    expect(m['Campanha']).toBe('franquia-setembro')
    expect(m['Canal da conversão']).toBe('facebook / cpc')
  })
})

// Zelo 18/09: uma fonte do RD recebe franquia, pedido de orçamento e vaga — o
// cliente pedindo orçamento recebia a abertura de franquia.
describe('pickIntroForOrigin', () => {
  const meta = {
    introText: 'FRANQUIA',
    introTemplateName: 'boas_vindas_v2',
    introTextRules: [
      { match: 'or[çc]amento|servi[çc]o', text: 'SERVICO', channelId: 'canal-recados' },
      { match: 'trabalhe|vaga|curr[ií]culo', text: 'VAGA', templateName: 'vaga_v1' },
      { match: '([', text: 'REGEX QUEBRADA' },
    ],
  }

  it('pedido de orçamento pega o texto de serviço e NÃO o template de franquia', () => {
    expect(pickIntroForOrigin(meta, 'https-limpezacomzelo-com-br-solicite-um-orcamento-11-09-26')).toEqual({
      text: 'SERVICO',
      templateName: null,
      channelId: 'canal-recados',
    })
  })

  it('regra com template próprio usa ele', () => {
    expect(pickIntroForOrigin(meta, 'trabalhe-conosco-2026')).toEqual({ text: 'VAGA', templateName: 'vaga_v1', channelId: null })
  })

  it('nada casou → abertura padrão da fonte (franquia)', () => {
    expect(pickIntroForOrigin(meta, 'seja-um-franqueado-site-01-09-26')).toEqual({
      text: 'FRANQUIA',
      templateName: 'boas_vindas_v2',
      channelId: null,
    })
    expect(pickIntroForOrigin(meta, '11/09/26 | v1 | Instant Forms Lóg. Condicional').text).toBe('FRANQUIA')
  })

  it('regex inválida na config é ignorada; sem regras e sem texto → nulos', () => {
    expect(pickIntroForOrigin({}, 'qualquer')).toEqual({ text: null, templateName: null, channelId: null })
  })
})
