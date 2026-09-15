import { describe, expect, it } from 'vitest'

import {
  buildTemplateRecipientSend,
  emptyTemplateMapping,
  missingValuesError,
  previewTemplate,
  resolveTemplateVar,
  templateNeeds,
  validateTemplateMapping,
  type TemplateSendMapping,
  type TemplateShape,
} from './template-vars'

// 15/09 (GoLink): disparo pela etapa do funil passa a aceitar template da API oficial.
const promo: TemplateShape & { footer_text?: string; header_media_url?: string } = {
  body_text: 'Oi {{1}}, a {{2}} preparou o dia do cliente pra você!',
  header_type: 'image',
  header_media_url: 'https://crm.exemplo.com/api/files/media/dia-do-cliente.jpg',
  buttons: [
    { type: 'QUICK_REPLY', text: 'Quero saber' },
    { type: 'URL', text: 'Ver oferta', url: 'https://golink.com.br/oferta/{{1}}' },
    { type: 'URL', text: 'Site', url: 'https://golink.com.br' },
  ],
  footer_text: 'GoLink',
}

const andressa = { name: 'Andressa Lima', phone: '5567999990001', email: '', company: 'Clínica Sorriso' }

describe('templateNeeds', () => {
  it('corpo, cabeçalho de mídia e só o botão de link com {{1}}', () => {
    expect(templateNeeds(promo)).toEqual({
      bodyIndices: [1, 2],
      headerText: false,
      headerMedia: 'image',
      urlButtons: [{ index: 1, text: 'Ver oferta' }],
    })
  })

  it('cabeçalho de texto com variável; sem variável não pede nada', () => {
    expect(templateNeeds({ body_text: 'Oi', header_type: 'text', header_content: 'Olá {{1}}' }).headerText).toBe(true)
    expect(templateNeeds({ body_text: 'Oi', header_type: 'text', header_content: 'Olá' }).headerText).toBe(false)
    expect(templateNeeds({ body_text: 'Oi' })).toEqual({
      bodyIndices: [],
      headerText: false,
      headerMedia: null,
      urlButtons: [],
    })
  })
})

describe('resolveTemplateVar', () => {
  it('campo do contato, com "Se faltar" quando vazio', () => {
    expect(resolveTemplateVar({ source: 'first_name', value: 'cliente' }, andressa)).toBe('Andressa')
    expect(resolveTemplateVar({ source: 'email', value: 'sem e-mail' }, andressa)).toBe('sem e-mail')
    expect(resolveTemplateVar({ source: 'email' }, andressa)).toBe('')
    expect(resolveTemplateVar({ source: 'company' }, andressa)).toBe('Clínica Sorriso')
  })

  it('texto fixo', () => {
    expect(resolveTemplateVar({ source: 'static', value: ' GoLink ' }, andressa)).toBe('GoLink')
    expect(resolveTemplateVar(undefined, andressa)).toBe('')
  })
})

describe('validateTemplateMapping', () => {
  const needs = templateNeeds(promo)

  it('começa em branco (com a mídia aprovada do template) e pede o que falta, na ordem', () => {
    const m = emptyTemplateMapping(needs, promo)
    expect(m.headerMediaUrl).toBe(promo.header_media_url)
    expect(validateTemplateMapping(needs, m)).toBe('Escreva o texto fixo de {{1}}.')
    m.variables['1'] = { source: 'first_name', value: 'cliente' }
    expect(validateTemplateMapping(needs, m)).toBe('Escreva o texto fixo de {{2}}.')
    m.variables['2'] = { source: 'static', value: 'GoLink' }
    expect(validateTemplateMapping(needs, m)).toBe('Preencha o final do link do botão "Ver oferta".')
    m.buttonValues = { '1': 'setembro' }
    expect(validateTemplateMapping(needs, m)).toBeNull()
  })

  it('mídia do cabeçalho obrigatória e com link válido', () => {
    const base: TemplateSendMapping = {
      variables: { '1': { source: 'name' }, '2': { source: 'company' } },
      buttonValues: { '1': 'x' },
    }
    expect(validateTemplateMapping(needs, { ...base, headerMediaUrl: '' })).toBe(
      'Este template tem imagem no cabeçalho: envie o arquivo.',
    )
    expect(validateTemplateMapping(needs, { ...base, headerMediaUrl: 'arquivo.jpg' })).toMatch(/link válido/)
  })

  it('variável sem mapeamento ou com origem desconhecida', () => {
    const n = templateNeeds({ body_text: '{{1}}' })
    expect(validateTemplateMapping(n, { variables: {} })).toBe('Escolha o que vai em {{1}}.')
    expect(
      validateTemplateMapping(n, { variables: { '1': { source: 'cpf' as never } } }),
    ).toBe('Escolha o que vai em {{1}}.')
  })
})

describe('buildTemplateRecipientSend', () => {
  const needs = templateNeeds(promo)
  const mapping: TemplateSendMapping = {
    variables: { '1': { source: 'first_name', value: 'cliente' }, '2': { source: 'email' } },
    buttonValues: { '1': 'setembro' },
    headerMediaUrl: 'https://crm.exemplo.com/api/files/media/nova.jpg',
  }

  it('params do corpo + mídia do cabeçalho + botão; aponta o que ficou vazio', () => {
    expect(buildTemplateRecipientSend(needs, mapping, andressa)).toEqual({
      params: ['Andressa', ''],
      messageParams: {
        headerMediaUrl: 'https://crm.exemplo.com/api/files/media/nova.jpg',
        buttonParams: { 1: 'setembro' },
      },
      missing: [2],
    })
  })

  it('template sem variável: nada de messageParams', () => {
    expect(buildTemplateRecipientSend(templateNeeds({ body_text: 'Oi' }), { variables: {} }, andressa)).toEqual({
      params: [],
      messageParams: undefined,
      missing: [],
    })
  })

  it('cabeçalho de texto', () => {
    const n = templateNeeds({ body_text: 'Oi', header_type: 'text', header_content: 'Olá {{1}}' })
    const r = buildTemplateRecipientSend(n, { variables: {}, headerVariable: { source: 'name' } }, { name: '' })
    expect(r.messageParams).toEqual({ headerText: '' })
    expect(r.missing).toEqual(['header'])
  })
})

describe('missingValuesError', () => {
  const mapping: TemplateSendMapping = {
    variables: { '1': { source: 'first_name' }, '2': { source: 'email' } },
    headerVariable: { source: 'company' },
  }

  it('diz quantos leads estão sem o campo', () => {
    expect(missingValuesError(mapping, new Map([[2, 4]]))).toBe(
      '4 leads estão sem e-mail pra {{2}}. Preencha o "Se faltar" ou escolha outro campo.',
    )
    expect(missingValuesError(mapping, new Map([['header', 1]]))).toBe(
      '1 lead está sem empresa pra {{1}} do cabeçalho. Preencha o "Se faltar" ou escolha outro campo.',
    )
    expect(missingValuesError(mapping, new Map())).toBeNull()
  })
})

describe('previewTemplate', () => {
  it('troca o que tem valor e deixa {{n}} no que falta', () => {
    const mapping: TemplateSendMapping = { variables: { '1': { source: 'first_name', value: 'cliente' } } }
    expect(previewTemplate(promo, mapping, andressa)).toEqual({
      header: null,
      body: 'Oi Andressa, a {{2}} preparou o dia do cliente pra você!',
      footer: 'GoLink',
    })
    expect(previewTemplate(promo, mapping, { name: '' }).body).toMatch(/^Oi cliente,/)
  })
})
