import { describe, it, expect } from 'vitest'

import { parseRdWebhook, mapRdLead, rdOriginLabel, pickIntroForOrigin, introDelivery } from './rdstation'

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

  it('lead de formulário não é conversão do RD CRM', () => {
    expect(mapRdLead(LEAD)!.selfConversion).toBeNull()
    expect(parseRdWebhook({ leads: [LEAD] })[0].selfConversion).toBeNull()
  })
})

// Zelo 01/10: o marketing via na nota "Campanha: unknown / Canal da conversão:
// unknown / unknown" — eventos que o PRÓPRIO RD CRM gera (quando o espelho cria
// ou mexe no negócio) passavam pelo filtro, sobrescreviam a campanha boa e
// abriam card indevido.
describe('mapRdLead — conversão do próprio RD CRM e origem genérica', () => {
  const FIRST_REAL = {
    created_at: '2026-09-10T10:00:00-03:00',
    content: { identificador: 'seja-um-franqueado-site' },
    conversion_origin: { source: 'Facebook Ads', medium: 'unknown', campaign: 'franquia-setembro' },
  }
  const synthetic = (label: string) => ({
    created_at: '2026-09-30T09:00:00-03:00',
    source: label,
    conversion_origin: { source: 'unknown', medium: 'unknown', campaign: 'unknown' },
  })

  for (const label of [
    'RD Station CRM',
    'Tarefa criada no RD Station CRM',
    'Tarefa atualizada no RD Station CRM',
    'Negociação criada no RD Station CRM',
  ]) {
    it(`"${label}" na última: marcada como do RD, fora da nota, origem da primeira`, () => {
      const lead = mapRdLead({ ...LEAD, first_conversion: FIRST_REAL, last_conversion: synthetic(label) })!
      expect(lead.selfConversion).toBe(label)
      expect(lead.meta['Primeira conversão']).toBe('seja-um-franqueado-site')
      expect(lead.meta['Última conversão']).toBeUndefined()
      expect(lead.meta['Campanha']).toBe('franquia-setembro')
      expect(lead.meta['Canal da conversão']).toBe('Facebook Ads')
      // A data é a da conversão do lead, não a do evento do CRM.
      expect(lead.meta['Data da conversão']).toBe('2026-09-10')
      expect(rdOriginLabel(lead)).toBe('seja-um-franqueado-site')
    })
  }

  it('olha TODOS os rótulos: o sintético escondido atrás de `source` também conta', () => {
    const lead = mapRdLead({
      ...LEAD,
      first_conversion: FIRST_REAL,
      last_conversion: {
        source: 'Formulário Contato',
        content: { identificador: 'Tarefa atualizada no RD Station CRM' },
      },
    })!
    expect(lead.selfConversion).toBe('Tarefa atualizada no RD Station CRM')
    expect(lead.meta['Última conversão']).toBeUndefined()
  })

  it('sem última conversão, vale a primeira (sintética → marcada)', () => {
    const lead = mapRdLead({ ...LEAD, first_conversion: synthetic('RD Station CRM'), last_conversion: null })!
    expect(lead.selfConversion).toBe('RD Station CRM')
    expect(lead.meta['Primeira conversão']).toBeUndefined()
    expect(lead.meta['Campanha']).toBeUndefined()
  })

  it('primeira sintética e última real: o lead entra, sem o rótulo do RD na nota', () => {
    const lead = mapRdLead({
      ...LEAD,
      first_conversion: synthetic('Negociação criada no RD Station CRM'),
      last_conversion: FIRST_REAL,
    })!
    expect(lead.selfConversion).toBeNull()
    expect(lead.meta['Primeira conversão']).toBeUndefined()
    expect(lead.meta['Última conversão']).toBe('seja-um-franqueado-site')
    expect(rdOriginLabel(lead)).toBe('seja-um-franqueado-site')
  })

  it('"unknown" na última conversão real cai na campanha boa da primeira', () => {
    const m = mapRdLead({
      ...LEAD,
      first_conversion: FIRST_REAL,
      last_conversion: {
        content: { identificador: 'Formulário Contato' },
        conversion_origin: { source: 'unknown', medium: 'unknown', campaign: 'unknown' },
      },
    })!.meta
    expect(m['Última conversão']).toBe('Formulário Contato')
    expect(m['Campanha']).toBe('franquia-setembro')
    expect(m['Canal da conversão']).toBe('Facebook Ads')
  })

  it('genérico parte a parte: o que diz algo na última fica, o resto vem da primeira', () => {
    const m = mapRdLead({
      ...LEAD,
      first_conversion: FIRST_REAL,
      last_conversion: {
        content: { identificador: 'Formulário Contato' },
        conversion_origin: { source: 'google', medium: '(not set)', campaign: 'unknown' },
      },
    })!.meta
    expect(m['Canal da conversão']).toBe('google')
    expect(m['Campanha']).toBe('franquia-setembro')
  })

  it('tudo "unknown": nenhuma linha de Campanha/Canal na nota', () => {
    const unknownOrigin = { source: 'unknown', medium: 'unknown', campaign: 'unknown', channel: 'Unknown' }
    const m = mapRdLead({
      ...LEAD,
      first_conversion: { ...LEAD.first_conversion, conversion_origin: unknownOrigin },
      last_conversion: { ...LEAD.last_conversion, conversion_origin: unknownOrigin },
    })!.meta
    expect(m['Campanha']).toBeUndefined()
    expect(m['Canal da conversão']).toBeUndefined()
    expect(m['Última conversão']).toBe('Formulário Contato')
  })

  it('fonte e meio genéricos: usa o canal agrupado do RD quando ele diz algo', () => {
    const m = mapRdLead({
      ...LEAD,
      last_conversion: {
        ...LEAD.last_conversion,
        conversion_origin: { source: 'unknown', medium: 'unknown', campaign: 'unknown', channel: 'Paid Search' },
      },
    })!.meta
    expect(m['Canal da conversão']).toBe('Paid Search')
  })

  it('rótulo "unknown" no `source` não vira nome da conversão', () => {
    const m = mapRdLead({
      ...LEAD,
      last_conversion: { source: 'unknown', content: { identificador: 'Formulário Contato' } },
    })!.meta
    expect(m['Última conversão']).toBe('Formulário Contato')
  })
})

// Zelo 18/09: uma fonte do RD recebe franquia, pedido de orçamento e vaga — o
// cliente pedindo orçamento recebia a abertura de franquia.
describe('pickIntroForOrigin', () => {
  const meta = {
    introText: 'FRANQUIA',
    introTemplateName: 'boas_vindas_v2',
    introCadenceId: 'cad-franquia',
    introTextRules: [
      { match: 'or[çc]amento|servi[çc]o', text: 'SERVICO', channelId: 'canal-recados' },
      { match: 'trabalhe|vaga|curr[ií]culo', text: 'VAGA', templateName: 'vaga_v1', cadenceId: 'cad-vaga' },
      { match: '([', text: 'REGEX QUEBRADA' },
    ],
  }

  it('pedido de orçamento pega o texto de serviço e NÃO o template nem a cadência de franquia', () => {
    expect(pickIntroForOrigin(meta, 'https-limpezacomzelo-com-br-solicite-um-orcamento-11-09-26')).toEqual({
      text: 'SERVICO',
      templateName: null,
      channelId: 'canal-recados',
      cadenceId: null,
      fallbackChannelId: null,
    })
  })

  it('regra com template e cadência próprios usa os dela', () => {
    expect(pickIntroForOrigin(meta, 'trabalhe-conosco-2026')).toEqual({
      text: 'VAGA',
      templateName: 'vaga_v1',
      channelId: null,
      cadenceId: 'cad-vaga',
      fallbackChannelId: null,
    })
  })

  it('nada casou → abertura e cadência padrão da fonte (franquia)', () => {
    expect(pickIntroForOrigin(meta, 'seja-um-franqueado-site-01-09-26')).toEqual({
      text: 'FRANQUIA',
      templateName: 'boas_vindas_v2',
      channelId: null,
      cadenceId: 'cad-franquia',
      fallbackChannelId: null,
    })
    expect(pickIntroForOrigin(meta, '11/09/26 | v1 | Instant Forms Lóg. Condicional').text).toBe('FRANQUIA')
  })

  it('regex inválida na config é ignorada; sem regras e sem texto → nulos', () => {
    expect(pickIntroForOrigin({}, 'qualquer')).toEqual({
      text: null,
      templateName: null,
      channelId: null,
      cadenceId: null,
      fallbackChannelId: null,
    })
  })
})

describe('introDelivery', () => {
  const orcamento = {
    text: 'SERVICO',
    templateName: 'orcamento_recebido',
    channelId: 'oficial',
    cadenceId: null,
    fallbackChannelId: 'recados',
  }

  it('modelo aprovado → oficial com o modelo', () => {
    expect(introDelivery(orcamento, true)).toEqual({
      channelId: 'oficial',
      templateName: 'orcamento_recebido',
      text: 'SERVICO',
      usedFallback: false,
    })
  })

  it('modelo ainda em análise → número reserva, em texto (o oficial não alcança lead novo sem modelo)', () => {
    expect(introDelivery(orcamento, false)).toEqual({
      channelId: 'recados',
      templateName: null,
      text: 'SERVICO',
      usedFallback: true,
    })
  })

  it('sem número reserva, segue o canal da regra (como antes)', () => {
    expect(introDelivery({ ...orcamento, fallbackChannelId: null }, false)).toEqual({
      channelId: 'oficial',
      templateName: 'orcamento_recebido',
      text: 'SERVICO',
      usedFallback: false,
    })
  })
})
