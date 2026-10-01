import { describe, it, expect } from 'vitest'
import {
  cleanOrigin,
  extractLeadFacts,
  factForFieldName,
  factForKey,
  isGenericOrigin,
  isSyntheticConversion,
  leadLinesForPrompt,
  parseNoteLines,
  prettyFormKey,
  prettyFormValue,
  usefulOrigin,
} from './lead-facts'

// Observações no formato que a entrada de lead do RD grava (dados fictícios).
const NOTES = [
  'Primeira conversão: 11/09/26 | v1 | Instant Forms Lóg. Condicional',
  'Data da conversão: 2026-09-18',
  'Ficha no RD: http://app.rdstation.com.br/leads/public/0000-aaaa',
  'você_confirma_que_tem_interesse_em_saber_mais_sobre_os_projetos_de_franquia?: sim,_tenho_interesse_em_conhecer',
  'pensando_em_te_apresentar_a_opção_certa_de_franquia_para_o_seu_momento,_quanto_você_teria_disponível_para_investir_hoje?: acima_de_r$50_mil',
  'city: Campinas',
  'state: SP',
  'lead_stage: Lead',
  'uuid: 0000-aaaa',
  'fit_score: d',
  'interest: 0',
].join('\n')

describe('parseNoteLines', () => {
  it('cuts at the first ": " and keeps loose text lines', () => {
    const pairs = parseNoteLines('Cidade: Campinas\nligar depois das 18h\n\nFicha: http://x.y/z')
    expect(pairs).toEqual([
      ['Cidade', 'Campinas'],
      ['', 'ligar depois das 18h'],
      ['Ficha', 'http://x.y/z'],
    ])
  })
})

describe('extractLeadFacts', () => {
  it('reads city, state, investment, interest and campaign from an RD lead', () => {
    const f = extractLeadFacts(parseNoteLines(NOTES))
    expect(f.cidade).toBe('Campinas')
    expect(f.estado).toBe('SP')
    expect(f.investimento).toBe('acima de R$50 mil')
    expect(f.interesse).toBe('sim, tenho interesse em conhecer')
    expect(f.campanha).toBe('11/09/26 | v1 | Instant Forms Lóg. Condicional')
    expect(f.inicio).toBeNull()
  })

  it('prefers the last conversion as campaign and a readable "valor de investimento"', () => {
    const f = extractLeadFacts([
      ['Primeira conversão', 'seja-um-franqueado-site'],
      ['Última conversão', 'solicite-um-orcamento'],
      ['valor de investimento', 'De R$51.000,00 a R$75.000,00'],
      ['seu estado', 'RS'],
      ['Quando pretende começar?', 'em_até_3_meses'],
    ])
    expect(f.campanha).toBe('solicite-um-orcamento')
    expect(f.investimento).toBe('De R$51.000,00 a R$75.000,00')
    expect(f.estado).toBe('RS')
    expect(f.inicio).toBe('em até 3 meses')
  })

  it('skips the synthetic "Negociação criada no RD" conversion as campaign', () => {
    const f = extractLeadFacts([
      ['Primeira conversão', 'solicite-um-orcamento'],
      ['Última conversão', 'Negociação criada no RD Station CRM'],
    ])
    expect(f.campanha).toBe('solicite-um-orcamento')
  })

  it('never takes the RD technical score "interest: 0" as interest', () => {
    expect(extractLeadFacts([['interest', '0']]).interesse).toBeNull()
  })

  // Zelo 01/10: "Campanha: unknown" ocupava o lugar e o fallback pro
  // identificador da conversão nunca rodava.
  it('ignores a generic campaign and falls back to the real conversion identifier', () => {
    const f = extractLeadFacts([
      ['Primeira conversão', 'seja-um-franqueado-site'],
      ['Última conversão', 'Tarefa criada no RD Station CRM'],
      ['Campanha', 'unknown'],
      ['Canal da conversão', 'unknown / unknown'],
    ])
    expect(f.campanha).toBe('seja-um-franqueado-site')
  })

  it('keeps only the useful part of a campaign ("Facebook Ads / unknown")', () => {
    expect(extractLeadFacts([['Campanha', 'Facebook Ads / unknown']]).campanha).toBe('Facebook Ads')
  })

  it('no useful campaign and only RD CRM conversions → no campaign at all', () => {
    const f = extractLeadFacts([
      ['Primeira conversão', 'RD Station CRM'],
      ['Última conversão', 'Tarefa atualizada no RD Station CRM'],
      ['Campanha', '(not set)'],
    ])
    expect(f.campanha).toBeNull()
  })
})

describe('isSyntheticConversion', () => {
  it('any "Negociação … no RD Station CRM" is the RD itself, not a lead', () => {
    expect(isSyntheticConversion('Negociação criada no RD Station CRM')).toBe(true)
    expect(isSyntheticConversion('Negociação atualizada no RD Station CRM')).toBe(true)
    expect(isSyntheticConversion('Negociação ganha no RD Station CRM')).toBe(true)
    expect(isSyntheticConversion('negociacao perdida no rd station crm')).toBe(true)
  })

  // Zelo 01/10: os de TAREFA e o "RD Station CRM" puro passavam pelo filtro,
  // trocavam a campanha por "unknown" e abriam card indevido.
  it('task events and the bare "RD Station CRM" label are the RD itself too', () => {
    expect(isSyntheticConversion('RD Station CRM')).toBe(true)
    expect(isSyntheticConversion('Tarefa criada no RD Station CRM')).toBe(true)
    expect(isSyntheticConversion('Tarefa atualizada no RD Station CRM')).toBe(true)
    expect(isSyntheticConversion('tarefa-criada-no-rd-station-crm')).toBe(true)
    expect(isSyntheticConversion('rd_station_crm')).toBe(true)
    expect(isSyntheticConversion('RDStation CRM')).toBe(true)
  })

  it('real form conversions pass', () => {
    expect(isSyntheticConversion('seja-um-franqueado-site-01-09-26')).toBe(false)
    expect(isSyntheticConversion('11/09/26 | v1 | Instant Forms Lóg. Condicional')).toBe(false)
    expect(isSyntheticConversion('Site | Form. Solicite um orçamento')).toBe(false)
    expect(isSyntheticConversion('RD Station')).toBe(false)
    expect(isSyntheticConversion('Formulário RD Station Marketing')).toBe(false)
    expect(isSyntheticConversion(null)).toBe(false)
  })

  // Revisão 01/10: lead de verdade que só CITA o RD não pode ser descartado.
  it('a real lead that only mentions RD Station CRM passes', () => {
    expect(isSyntheticConversion('lp-comparativo-rd-station-crm')).toBe(false)
    expect(isSyntheticConversion('Alternativa ao RD Station CRM')).toBe(false)
    expect(isSyntheticConversion('Webinar migração do RD Station CRM')).toBe(false)
  })
})

describe('campanha com parênteses (revisão 01/10)', () => {
  it('keeps campaign names that carry parentheses', () => {
    expect(cleanOrigin('(ABO) Leads Botox (Novo)')).toBe('(ABO) Leads Botox (Novo)')
    expect(cleanOrigin('(Site) Solicite um orçamento (v2)')).toBe('(Site) Solicite um orçamento (v2)')
    expect(isGenericOrigin('(ABO) Leads Botox (Novo)')).toBe(false)
    expect(isGenericOrigin('(not set)')).toBe(true)
  })
})

describe('cleanOrigin / isGenericOrigin', () => {
  it('drops generic parts one by one', () => {
    expect(cleanOrigin('Facebook Ads / unknown')).toBe('Facebook Ads')
    expect(cleanOrigin('unknown | Instant Forms')).toBe('Instant Forms')
    expect(cleanOrigin('facebook/unknown')).toBe('facebook')
    expect(cleanOrigin('(direct) / (none)')).toBe('(direct)')
    expect(cleanOrigin('google / (not set) / cpc')).toBe('google / cpc')
  })

  it('nothing useful → empty (and generic)', () => {
    for (const v of ['unknown', 'Unknown', 'unknown / unknown', '(not set)', 'not_set', 'n/a', '-', 'desconhecido', '', null]) {
      expect(cleanOrigin(v)).toBe('')
      expect(isGenericOrigin(v)).toBe(true)
    }
  })

  it('usefulOrigin also refuses the RD CRM own label', () => {
    expect(usefulOrigin('Tarefa criada no RD Station CRM')).toBe('')
    expect(usefulOrigin('Facebook Ads / unknown')).toBe('Facebook Ads')
    expect(usefulOrigin('RD Station')).toBe('RD Station')
  })

  it('leaves real values intact: dates, pipes and URLs', () => {
    const v = '11/09/26 | v1 | Instant Forms Lóg. Condicional'
    expect(cleanOrigin(v)).toBe(v)
    expect(isGenericOrigin(v)).toBe(false)
    expect(cleanOrigin('https://exemplo.com/unknown')).toBe('https://exemplo.com/unknown')
    expect(cleanOrigin('franquia-setembro')).toBe('franquia-setembro')
  })
})

describe('prettyFormValue / prettyFormKey', () => {
  it('turns RD slugs into text and leaves URLs alone', () => {
    expect(prettyFormValue('acima_de_r$50_mil')).toBe('acima de R$50 mil')
    expect(prettyFormValue('Porto Alegre')).toBe('Porto Alegre')
    expect(prettyFormValue('http://app.rd/leads_x')).toBe('http://app.rd/leads_x')
    expect(prettyFormKey('seu_estado?:')).toBe('Seu estado?')
  })
})

describe('factForFieldName', () => {
  it('maps the account custom fields by name', () => {
    expect(factForFieldName('Cidade')).toBe('cidade')
    expect(factForFieldName('UF')).toBe('estado')
    expect(factForFieldName('Capital disponível')).toBe('investimento')
    expect(factForFieldName('Quando pretende começar')).toBe('inicio')
    expect(factForFieldName('Campanha')).toBe('campanha')
    expect(factForFieldName('Segmento')).toBeNull()
  })
})

describe('factForKey', () => {
  it('ignores technical RD keys', () => {
    expect(factForKey('uuid')).toBeNull()
    expect(factForKey('fit_score')).toBeNull()
    expect(factForKey('city')).toBe('cidade')
  })
})

describe('leadLinesForPrompt', () => {
  it('drops technical lines, prettifies and skips facts already on the card', () => {
    const lines = leadLinesForPrompt(parseNoteLines(NOTES), new Set(['cidade', 'estado']))
    expect(lines).toContain('Primeira conversão: 11/09/26 | v1 | Instant Forms Lóg. Condicional')
    expect(lines.some((l) => l.startsWith('Pensando em te apresentar') && l.endsWith('acima de R$50 mil'))).toBe(true)
    expect(lines.some((l) => /uuid|fit score|lead stage|Ficha no RD/i.test(l))).toBe(false)
    expect(lines.some((l) => l.startsWith('City'))).toBe(false)
    expect(lines.some((l) => l.startsWith('State'))).toBe(false)
  })

  // Zelo 01/10: a Zélia recebia "Campanha: unknown" no prompt.
  it('skips generic origin lines and the RD CRM own conversion, cleans part by part', () => {
    const lines = leadLinesForPrompt(
      parseNoteLines(
        [
          'Primeira conversão: seja-um-franqueado-site',
          'Última conversão: Tarefa criada no RD Station CRM',
          'Campanha: unknown',
          'Canal da conversão: Facebook Ads / unknown',
        ].join('\n'),
      ),
    )
    expect(lines).toEqual(['Primeira conversão: seja-um-franqueado-site', 'Canal da conversão: Facebook Ads'])
  })

  it('drops the channel line when every part is generic', () => {
    const lines = leadLinesForPrompt([['Canal da conversão', 'unknown / unknown']])
    expect(lines).toEqual([])
  })
})
