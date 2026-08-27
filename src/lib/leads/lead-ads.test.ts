import crypto from 'node:crypto'

import { describe, it, expect } from 'vitest'

import { parseMetaLeadEvents, hasMetaLeadEvents } from '@/lib/leads/providers/meta'
import { parseTikTokLeadEvents } from '@/lib/leads/providers/tiktok'
import {
  parseLinkedInLeadEvents,
  hasLinkedInLeadEvents,
  verifyLinkedInSignature,
  linkedInChallengeResponse,
  resolveLinkedInLead,
} from '@/lib/leads/providers/linkedin'
import type { LoadedLeadSource } from '@/lib/leads/sources'
import { mapContactFields, buildLeadNotes } from '@/lib/leads/providers/shared'

// Corpo real de um webhook de leadgen do Meta (object:'page').
const META_LEADGEN = {
  object: 'page',
  entry: [
    {
      id: '1158771580642406',
      time: 1690000000,
      changes: [
        {
          field: 'leadgen',
          value: {
            leadgen_id: '9999',
            page_id: '1158771580642406',
            form_id: 'form123',
            ad_id: 'ad456',
            created_time: 1690000000,
          },
        },
      ],
    },
  ],
}

// Um webhook de MENSAGEM do Messenger (não é leadgen) — pra provar que a
// delegação de leadgen não pega mensagem por engano.
const META_MESSAGE = {
  object: 'page',
  entry: [
    { id: '1158771580642406', messaging: [{ sender: { id: 'psid' }, message: { text: 'oi' } }] },
  ],
}

describe('Meta Lead Ads — parse do webhook', () => {
  it('extrai page_id, form_id, leadgen_id e ad_id do leadgen', () => {
    const events = parseMetaLeadEvents(META_LEADGEN)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      pageId: '1158771580642406',
      formId: 'form123',
      leadgenId: '9999',
      adId: 'ad456',
      createdTime: 1690000000,
    })
  })

  it('hasMetaLeadEvents distingue leadgen de mensagem', () => {
    expect(hasMetaLeadEvents(META_LEADGEN)).toBe(true)
    expect(hasMetaLeadEvents(META_MESSAGE)).toBe(false)
  })
})

describe('mapeamento de campos do formulário (Meta/TikTok)', () => {
  it('mapeia nome/telefone/e-mail/empresa (nomes padrão)', () => {
    const fields = {
      full_name: 'Fulano de Tal',
      phone_number: '+55 67 99999-8888',
      email: 'fulano@ex.com',
      company_name: 'Loja X',
      cidade: 'Campo Grande',
    }
    expect(mapContactFields(fields)).toEqual({
      name: 'Fulano de Tal',
      phone: '+55 67 99999-8888',
      email: 'fulano@ex.com',
      company: 'Loja X',
    })
  })

  it('cai pra first+last name e casa telefone por campo custom', () => {
    const fields = {
      first_name: 'Ana',
      last_name: 'Souza',
      seu_whatsapp_para_contato: '67988887777',
      'e-mail': 'ana@ex.com',
    }
    const c = mapContactFields(fields)
    expect(c.name).toBe('Ana Souza')
    expect(c.phone).toBe('67988887777') // casou por "contains whatsapp"
    expect(c.email).toBe('ana@ex.com')
  })

  it('LinkedIn: nome camelCase minúsculo (firstname/lastname) — bug do 1º teste 27/08', () => {
    const fields = {
      firstname: 'Carlos',
      lastname: 'Teste Fluxia',
      emailaddress: 'carlos@ex.com',
      phonenumber: '5567988887777',
      companyname: 'Padaria Modelo',
    }
    const c = mapContactFields(fields)
    expect(c.name).toBe('Carlos Teste Fluxia')
    expect(c.phone).toBe('5567988887777') // contains "phone"
    expect(c.email).toBe('carlos@ex.com') // contains "email"
    expect(c.company).toBe('Padaria Modelo') // contains "company"
  })

  it('buildLeadNotes inclui extras + metadados e exclui os campos já usados', () => {
    const fields = {
      full_name: 'Fulano de Tal',
      phone_number: '+5567999998888',
      cidade: 'Campo Grande',
      interesse: 'Plano premium',
    }
    const meta = { Campanha: 'Agosto Leads' }
    const known = ['Fulano de Tal', '+5567999998888', null, null]
    const notes = buildLeadNotes(fields, meta, known)
    expect(notes).toContain('Campanha: Agosto Leads')
    expect(notes).toContain('cidade: Campo Grande')
    expect(notes).toContain('interesse: Plano premium')
    expect(notes).not.toContain('Fulano de Tal') // já virou o nome
  })
})

describe('TikTok — parse tolerante do webhook', () => {
  it('extrai advertiser_id/lead_id + campos inline (field_data)', () => {
    const body = {
      advertiser_id: '700123',
      data: {
        lead_id: 'L1',
        form_id: 'F1',
        field_data: [
          { name: 'name', values: ['Beto'] },
          { name: 'phone_number', values: ['67911112222'] },
        ],
      },
    }
    const events = parseTikTokLeadEvents(body)
    expect(events).toHaveLength(1)
    expect(events[0].advertiserId).toBe('700123')
    expect(events[0].leadId).toBe('L1')
    expect(events[0].inlineFields).toEqual({
      name: 'Beto',
      phone_number: '67911112222',
    })
  })
})

describe('LinkedIn Lead Sync — parse tolerante do webhook', () => {
  it('extrai organization id da URN + leadId (leadNotifications)', () => {
    const body = {
      elements: [
        {
          owner: 'urn:li:organization:144549939',
          leadFormResponse: 'urn:li:leadGenFormResponse:6789',
          form: 'urn:li:leadGenForm:555',
        },
      ],
    }
    const events = parseLinkedInLeadEvents(body)
    expect(events).toHaveLength(1)
    expect(events[0].organizationId).toBe('144549939')
    expect(events[0].leadId).toBe('urn:li:leadGenFormResponse:6789')
    expect(events[0].formId).toBe('urn:li:leadGenForm:555')
  })

  it('lê campos inline no formato answers do LinkedIn', () => {
    const body = {
      owner: 'urn:li:organization:144549939',
      id: 'resp-1',
      answers: [
        { name: 'first_name', answer: 'Ana' },
        { name: 'last_name', answer: 'Souza' },
        {
          name: 'phone_number',
          answerDetails: { textQuestionAnswer: { answer: '67988887777' } },
        },
        { name: 'email', answer: 'ana@ex.com' },
      ],
    }
    const events = parseLinkedInLeadEvents(body)
    expect(events).toHaveLength(1)
    expect(events[0].inlineFields).toEqual({
      first_name: 'Ana',
      last_name: 'Souza',
      phone_number: '67988887777',
      email: 'ana@ex.com',
    })
  })

  it('hasLinkedInLeadEvents distingue lead de corpo vazio', () => {
    expect(hasLinkedInLeadEvents({ owner: 'urn:li:organization:1', id: 'x' })).toBe(true)
    expect(hasLinkedInLeadEvents({ ping: true })).toBe(false)
  })

  it('valida a assinatura HMAC-SHA256 (base64 e hex) e rejeita a errada', () => {
    const secret = 'client-secret-123'
    const raw = JSON.stringify({ owner: 'urn:li:organization:1', id: 'x' })
    const b64 = crypto.createHmac('sha256', secret).update(raw).digest('base64')
    const hex = crypto.createHmac('sha256', secret).update(raw).digest('hex')
    expect(verifyLinkedInSignature(raw, b64, secret)).toBe(true)
    expect(verifyLinkedInSignature(raw, hex, secret)).toBe(true)
    expect(verifyLinkedInSignature(raw, `sha256=${hex}`, secret)).toBe(true)
    expect(verifyLinkedInSignature(raw, 'deadbeef', secret)).toBe(false)
    expect(verifyLinkedInSignature(raw, b64, 'outro-secret')).toBe(false)
  })

  it('responde ao desafio com o HMAC hex do challengeCode', () => {
    const secret = 'client-secret-123'
    const code = 'abc123'
    const expected = crypto.createHmac('sha256', secret).update(code).digest('hex')
    expect(linkedInChallengeResponse(code, secret)).toBe(expected)
    expect(linkedInChallengeResponse(code, null)).toBeNull()
  })

  it('resolve o lead a partir dos campos inline (sem buscar na API)', async () => {
    const source = {
      accessToken: 'tok',
      providerMeta: {},
    } as unknown as LoadedLeadSource
    const ev = {
      organizationId: '144549939',
      leadId: 'resp-1',
      formId: null,
      inlineFields: {
        full_name: 'Ana Souza',
        phone_number: '67988887777',
        email: 'ana@ex.com',
        empresa: 'Loja X',
      },
    }
    const lead = await resolveLinkedInLead(source, ev)
    expect(lead).not.toBeNull()
    expect(lead).toMatchObject({
      name: 'Ana Souza',
      phone: '67988887777',
      email: 'ana@ex.com',
      company: 'Loja X',
    })
  })
})
