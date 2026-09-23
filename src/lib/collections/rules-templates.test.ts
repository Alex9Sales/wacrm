import { describe, expect, it } from 'vitest'

import {
  ASAAS_WHATSAPP_FEE_DEFAULT,
  collectionGreetingName,
  fillTemplateParams,
  missingTemplateVars,
  normalizeSettings,
  templateForKind,
  templateKindOf,
  templateVarsFromPayload,
} from './rules'


describe('templates por tipo de mensagem (23/09)', () => {
  it('normaliza só tipos conhecidos com nome; o resto cai fora', () => {
    const s = normalizeSettings({
      templatesByKind: {
        reminder: { name: 'lembrete_v1', language: 'pt_BR', params: ['{nome}', 7] },
        due_today: { name: '   ' },
        bogus: { name: 'x' },
        manual: 'nao-objeto',
      },
    })
    expect(s.templatesByKind).toEqual({ reminder: { name: 'lembrete_v1', language: 'pt_BR', params: ['{nome}'] } })
    expect(normalizeSettings({}).templatesByKind).toEqual({})
  })

  it('templateForKind: o do tipo → o padrão → nenhum', () => {
    const base = normalizeSettings({ templateName: 'padrao', templateLanguage: 'pt_BR', templateParams: ['{nome}'], templatesByKind: { reminder: { name: 'lembrete_v1', language: 'pt_BR', params: [] } } })
    expect(templateForKind(base, 'reminder')?.name).toBe('lembrete_v1')
    expect(templateForKind(base, 'collection')?.name).toBe('padrao')
    expect(templateForKind(base, 'manual')?.params).toEqual(['{nome}'])
    expect(templateForKind(normalizeSettings({}), 'collection')).toBeNull()
  })

  it('templateKindOf: kind do pedido → tipo; sem kind = cobrança da régua', () => {
    expect(templateKindOf(undefined)).toBe('collection')
    expect(templateKindOf('reminder')).toBe('reminder')
    expect(templateKindOf('due_today')).toBe('due_today')
    expect(templateKindOf('new_charge')).toBe('new_charge')
    expect(templateKindOf('manual')).toBe('manual')
    expect(templateKindOf('qualquer')).toBe('collection')
  })

  it('fillTemplateParams troca as chaves e zera as sem dado (a Meta rejeita chave literal)', () => {
    expect(fillTemplateParams(['{nome}', 'Parcela de {valor}', '{link}', '{DIAS}', 'fixo'], { nome: 'Ana', valor: 'R$ 10,00', link: 'https://x' })).toEqual([
      'Ana',
      'Parcela de R$ 10,00',
      'https://x',
      '',
      'fixo',
    ])
  })

  it('missingTemplateVars: aponta a variável que ficou vazia (a Meta recusa parâmetro vazio)', () => {
    expect(missingTemplateVars(['{nome}', '{valor}', 'fixo', '{link}'], { nome: 'Ana', valor: '', link: 'https://x' })).toEqual(['{valor}'])
    expect(missingTemplateVars(['{nome}'], { nome: 'Ana' })).toEqual([])
    expect(missingTemplateVars(['Vence em {dias} dias'], { nome: 'Ana' })).toEqual(['Vence em {dias} dias'])
  })

  it('templateVarsFromPayload: régua (maxDaysLate), lembrete (dueIn), aviso do dia ("hoje")', () => {
    expect(templateVarsFromPayload({ total: 1234.5, links: ['https://a', 'https://b'], charges: 2, maxDaysLate: 7 })).toEqual({
      // Intl usa espaço inflexível entre "R$" e o número.
      valor: (1234.5).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      link: 'https://a',
      dias: '7',
      parcelas: '2',
    })
    expect(templateVarsFromPayload({ kind: 'reminder', dueIn: 3 }).dias).toBe('3')
    expect(templateVarsFromPayload({ kind: 'due_today', dueIn: 0 }).dias).toBe('hoje')
    expect(templateVarsFromPayload({})).toEqual({ valor: '', link: '', dias: '', parcelas: '' })
  })
})

describe('collectionGreetingName — pessoa no Asaas manda; empresa no Asaas + pessoa no CRM cumprimenta a pessoa', () => {
  it('nome de pessoa no Asaas vale, mesmo com apelido no CRM', () => {
    expect(collectionGreetingName('Maria Silva Souza', 'Loja 77')).toBe('Maria Silva Souza')
    expect(collectionGreetingName('Maria Silva Souza Lima Prado', 'Loja 77')).toBe('Maria Silva')
  })
  it('empresa no Asaas e pessoa no CRM → primeiro nome da pessoa', () => {
    expect(collectionGreetingName('Clínica Jump Ltda', 'Jessica Almeida')).toBe('Jessica')
    expect(collectionGreetingName('Google Ads', 'ANA')).toBe('Ana')
  })
  it('empresa nos dois → a empresa como está no Asaas', () => {
    expect(collectionGreetingName('Clínica Jump', 'Clinica Jump Recepção')).toBe('Clínica Jump')
  })
  it('apelido do WhatsApp (name_source whatsapp) não vira saudação; nome digitado (crm/phonebook) vira', () => {
    expect(collectionGreetingName('Clínica Jump Ltda', 'Jump Odonto 🦷', 'whatsapp')).toBe('Clínica Jump')
    expect(collectionGreetingName('Clínica Jump Ltda', 'Tudo passa 🙏', 'whatsapp')).toBe('Clínica Jump')
    expect(collectionGreetingName('Clínica Jump Ltda', 'Jessica Almeida', 'crm')).toBe('Jessica')
    expect(collectionGreetingName('Clínica Jump Ltda', 'Jessica Almeida', 'phonebook')).toBe('Jessica')
    expect(collectionGreetingName('Clínica Jump Ltda', 'Jessica Almeida', 'whatsapp')).toBe('Clínica Jump')
  })
  it('sem Asaas → o CRM quando é pessoa; telefone/frase no CRM → nada ("Oi!")', () => {
    expect(collectionGreetingName(null, 'Carlos')).toBe('Carlos')
    expect(collectionGreetingName(null, '+55 12 99123-4567')).toBeNull()
    expect(collectionGreetingName('', 'Meus Netinhos Queridos')).toBeNull()
    expect(collectionGreetingName('', '')).toBeNull()
  })
})

describe('asaasWhatsAppFee', () => {
  it('padrão da tabela pública; aceita ajuste; recusa lixo e negativo', () => {
    expect(normalizeSettings({}).asaasWhatsAppFee).toBe(ASAAS_WHATSAPP_FEE_DEFAULT)
    expect(normalizeSettings({ asaasWhatsAppFee: 0.7 }).asaasWhatsAppFee).toBe(0.7)
    expect(normalizeSettings({ asaasWhatsAppFee: -1 }).asaasWhatsAppFee).toBe(ASAAS_WHATSAPP_FEE_DEFAULT)
    expect(normalizeSettings({ asaasWhatsAppFee: 0 }).asaasWhatsAppFee).toBe(ASAAS_WHATSAPP_FEE_DEFAULT)
    expect(normalizeSettings({ asaasWhatsAppFee: 'x' }).asaasWhatsAppFee).toBe(ASAAS_WHATSAPP_FEE_DEFAULT)
  })
  it('ajuste pontual nunca zera o padrão de quem não mexeu', () => {
    expect(normalizeSettings({ templateName: 'x' }).asaasWhatsAppFee).toBe(ASAAS_WHATSAPP_FEE_DEFAULT)
  })
})
