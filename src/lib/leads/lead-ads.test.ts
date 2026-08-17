import { describe, it, expect } from 'vitest'

import { parseMetaLeadEvents, hasMetaLeadEvents } from '@/lib/leads/providers/meta'
import { parseTikTokLeadEvents } from '@/lib/leads/providers/tiktok'
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
