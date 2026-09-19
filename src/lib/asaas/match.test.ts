import { describe, expect, it } from 'vitest'

import {
  asaasPhoneForContact,
  brPhoneCandidates,
  daysOverdue,
  decideMatch,
  decideWithLink,
  groupDuplicateCustomers,
  hasFullAddress,
  normalizeDocument,
  normalizeEmail,
  pickCustomerForDocument,
  pickCustomerForReference,
} from './match'

describe('brPhoneCandidates', () => {
  it('acha o mesmo celular gravado com e sem o 55', () => {
    const semDDI = brPhoneCandidates('(67) 99000-1631')
    expect(semDDI).toContain('67990001631')
    expect(semDDI).toContain('5567990001631')

    const comDDI = brPhoneCandidates('5567990001631')
    expect(comDDI).toContain('67990001631')
  })

  it('cobre o 9º dígito nos dois sentidos (número antigo × novo)', () => {
    expect(brPhoneCandidates('6790001631')).toContain('67990001631')
    expect(brPhoneCandidates('67990001631')).toContain('6790001631')
  })

  it('não inventa DDI para DDD que não existe', () => {
    // 00 não é DDD válido: nada de prefixar 55 e criar um número fantasma.
    expect(brPhoneCandidates('0012345678')).not.toContain('550012345678')
  })

  it('ignora entrada curta demais para ser telefone', () => {
    expect(brPhoneCandidates('1234')).toEqual([])
    expect(brPhoneCandidates(null)).toEqual([])
  })
})

describe('decideMatch — nunca chuta', () => {
  it('casa quando há exatamente um contato', () => {
    expect(decideMatch([{ id: 'c1', via: 'phone' }])).toEqual({
      contactId: 'c1',
      matchedBy: 'phone',
      ambiguous: false,
    })
  })

  it('NÃO casa quando o telefone bate com dois contatos diferentes', () => {
    const d = decideMatch([
      { id: 'c1', via: 'phone' },
      { id: 'c2', via: 'phone' },
    ])
    expect(d.contactId).toBeNull()
    expect(d.ambiguous).toBe(true)
  })

  it('prefere telefone a e-mail quando os dois acham alguém', () => {
    const d = decideMatch([
      { id: 'c-phone', via: 'phone' },
      { id: 'c-mail', via: 'email' },
    ])
    expect(d.contactId).toBe('c-phone')
    expect(d.matchedBy).toBe('phone')
  })

  it('empate no telefone não escorrega para o e-mail — vira pendência', () => {
    // Ambiguidade é sinal de dado sujo; cair no próximo critério só esconderia.
    const d = decideMatch([
      { id: 'c1', via: 'phone' },
      { id: 'c2', via: 'phone' },
      { id: 'c3', via: 'email' },
    ])
    expect(d.contactId).toBeNull()
    expect(d.ambiguous).toBe(true)
  })

  it('sem candidato nenhum é pendência, não é ambiguidade', () => {
    expect(decideMatch([])).toEqual({ contactId: null, matchedBy: null, ambiguous: false })
  })

  it('o mesmo contato achado duas vezes ainda é um só', () => {
    const d = decideMatch([
      { id: 'c1', via: 'phone' },
      { id: 'c1', via: 'phone' },
    ])
    expect(d.contactId).toBe('c1')
    expect(d.ambiguous).toBe(false)
  })
})

describe('decideWithLink — o vínculo feito por uma pessoa vence o palpite (16/09)', () => {
  it('com vínculo e o telefone apontando para OUTRO contato, vence o vínculo (caso Ótica Exemplo)', () => {
    expect(decideWithLink('c9', [{ id: 'c1', via: 'phone' }])).toEqual({ contactId: 'c9', matchedBy: 'manual', ambiguous: false })
  })

  it('com vínculo, empate de telefone deixa de ser pendência', () => {
    const d = decideWithLink('c9', [
      { id: 'c1', via: 'phone' },
      { id: 'c2', via: 'phone' },
    ])
    expect(d).toEqual({ contactId: 'c9', matchedBy: 'manual', ambiguous: false })
  })

  it('com vínculo e sem candidato nenhum, casa pelo vínculo', () => {
    expect(decideWithLink('c9', [])).toEqual({ contactId: 'c9', matchedBy: 'manual', ambiguous: false })
  })

  it('sem vínculo é igual ao decideMatch, nos três níveis', () => {
    const casos: Parameters<typeof decideMatch>[0][] = [
      [{ id: 'c1', via: 'phone' }],
      [{ id: 'c1', via: 'phone' }, { id: 'c2', via: 'phone' }],
      [{ id: 'm1', via: 'email' }],
      [{ id: 'm1', via: 'email' }, { id: 'm2', via: 'email' }],
      [{ id: 'k1', via: 'code' }],
      [],
    ]
    for (const c of casos) {
      expect(decideWithLink(null, c)).toEqual(decideMatch(c))
      expect(decideWithLink(undefined, c)).toEqual(decideMatch(c))
      expect(decideWithLink('', c)).toEqual(decideMatch(c))
    }
  })
})

describe('normalizeDocument', () => {
  it('aceita CPF e CNPJ formatados', () => {
    expect(normalizeDocument('123.456.789-09')).toBe('12345678909')
    expect(normalizeDocument('12.345.678/0001-95')).toBe('12345678000195')
  })

  it('recusa número com tamanho que não é de documento', () => {
    expect(normalizeDocument('12345')).toBe('')
    expect(normalizeDocument(null)).toBe('')
  })
})

describe('normalizeEmail', () => {
  it('compara sem caixa e sem espaço', () => {
    expect(normalizeEmail('  Joao@Empresa.COM ')).toBe('joao@empresa.com')
  })
})

describe('daysOverdue', () => {
  const hoje = new Date(2026, 8, 3) // 03/09/2026

  it('conta os dias desde o vencimento', () => {
    expect(daysOverdue('2026-08-31', hoje)).toBe(3)
  })

  it('vence hoje é zero, não é atraso', () => {
    expect(daysOverdue('2026-09-03', hoje)).toBe(0)
  })

  it('devolve negativo para o que ainda não venceu', () => {
    expect(daysOverdue('2026-09-10', hoje)).toBe(-7)
  })

  it('sem data devolve nulo em vez de fingir zero', () => {
    expect(daysOverdue(null, hoje)).toBeNull()
    expect(daysOverdue('sem-data', hoje)).toBeNull()
  })
})

describe('asaasPhoneForContact — telefone do Asaas vira contato', () => {
  it('celular e fixo nacionais ganham o 55', () => {
    expect(asaasPhoneForContact('67990001631')).toBe('5567990001631')
    expect(asaasPhoneForContact('(67) 99000-1631')).toBe('5567990001631')
    expect(asaasPhoneForContact('6730001631')).toBe('556730001631')
  })

  it('já com 55 fica como está', () => {
    expect(asaasPhoneForContact('+55 67 99000-1631')).toBe('5567990001631')
  })

  it('vazio, curto demais, DDD impossível ou estrangeiro → null (vira pendência, não contato)', () => {
    expect(asaasPhoneForContact('')).toBeNull()
    expect(asaasPhoneForContact(null)).toBeNull()
    expect(asaasPhoneForContact('99000')).toBeNull()
    expect(asaasPhoneForContact('0190001631')).toBeNull()
    // 19/09: DDI + DDD + 7 dígitos (faltou um) — antes virava 5555129888381.
    expect(asaasPhoneForContact('55129888381')).toBeNull()
    expect(asaasPhoneForContact('5555129888381')).toBeNull()
    expect(asaasPhoneForContact('+370 60001234')).toBeNull()
  })
})

describe('groupDuplicateCustomers — o mesmo cliente ×3', () => {
  it('agrupa por CPF, e cada cadastro entra em um grupo só', () => {
    const g = groupDuplicateCustomers([
      { id: 'a', name: 'Carlos', cpfCnpj: '123.456.789-00', mobilePhone: '67999990011' },
      { id: 'b', name: 'Carlos Tste', cpfCnpj: '12345678900', mobilePhone: '5567999990011' },
      { id: 'c', name: 'Carlos T', cpfCnpj: '12345678900', mobilePhone: '6799990011' },
      { id: 'd', name: 'Outra pessoa', cpfCnpj: '98765432100', mobilePhone: '67911112222' },
    ])
    expect(g).toHaveLength(1)
    expect(g[0].by).toBe('cpf')
    expect(g[0].customers.map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('sem CPF, agrupa por telefone tolerando 55 e 9º dígito; e-mail por último', () => {
    const g = groupDuplicateCustomers([
      { id: 'a', name: 'Ana', mobilePhone: '(67) 99000-1631' },
      { id: 'b', name: 'Ana Paula', mobilePhone: '556790001631' },
      { id: 'c', name: 'Beto', email: 'Beto@x.com' },
      { id: 'd', name: 'Roberto', email: 'beto@x.com' },
      { id: 'e', name: 'Solo', email: 'solo@x.com' },
    ])
    expect(g.map((x) => x.by)).toEqual(['phone', 'email'])
    expect(g[0].customers.map((c) => c.id)).toEqual(['a', 'b'])
    expect(g[1].customers.map((c) => c.id)).toEqual(['c', 'd'])
  })
})

describe('qual cadastro recebe a cobrança (15/09)', () => {
  const CNPJ = '11222333000181'
  const OUTRO = '52998224725'
  const REF = '0f0e0d0c-0b0a-4908-8706-050403020100'

  it('hasFullAddress: CEP e número preenchidos', () => {
    expect(hasFullAddress({ postalCode: '79000-000', addressNumber: '12' })).toBe(true)
    expect(hasFullAddress({ postalCode: '79000000', addressNumber: ' ' })).toBe(false)
    expect(hasFullAddress({})).toBe(false)
  })

  describe('pickCustomerForDocument', () => {
    it('caso João: órfão nosso sem endereço (mais novo) × cadastro com endereço (mais antigo) → o com endereço', () => {
      const orfao = { id: 'cus_000000000009', cpfCnpj: CNPJ, externalReference: REF, dateCreated: '2026-09-15' }
      const real = { id: 'cus_000000000002', cpfCnpj: '11.222.333/0001-81', postalCode: '79000000', addressNumber: '100', dateCreated: '2025-01-10' }
      expect(pickCustomerForDocument([orfao, real], CNPJ, REF)?.id).toBe('cus_000000000002')
    })
    it('endereço completo vence mesmo sendo o mais novo', () => {
      const antigo = { id: 'cus_1', cpfCnpj: CNPJ, dateCreated: '2024-01-01' }
      const comEndereco = { id: 'cus_2', cpfCnpj: CNPJ, postalCode: '79000000', addressNumber: '1', dateCreated: '2026-01-01' }
      expect(pickCustomerForDocument([antigo, comEndereco], CNPJ, REF)?.id).toBe('cus_2')
    })
    it('ignora apagado e quem tem outro documento', () => {
      const apagado = { id: 'cus_1', cpfCnpj: CNPJ, postalCode: '79000000', addressNumber: '1', deleted: true, dateCreated: '2020-01-01' }
      const outro = { id: 'cus_2', cpfCnpj: OUTRO, dateCreated: '2020-01-01' }
      const certo = { id: 'cus_3', cpfCnpj: CNPJ, dateCreated: '2026-01-01' }
      expect(pickCustomerForDocument([apagado, outro, certo], CNPJ, REF)?.id).toBe('cus_3')
      expect(pickCustomerForDocument([apagado, outro], CNPJ, REF)).toBeUndefined()
    })
    it('sem endereço nos dois → o mais antigo; sem data → menor id', () => {
      expect(pickCustomerForDocument([
        { id: 'cus_1', cpfCnpj: CNPJ, dateCreated: '2026-05-01' },
        { id: 'cus_2', cpfCnpj: CNPJ, dateCreated: '2025-05-01' },
      ], CNPJ)?.id).toBe('cus_2')
      expect(pickCustomerForDocument([
        { id: 'cus_000000000010', cpfCnpj: CNPJ },
        { id: 'cus_000000000009', cpfCnpj: CNPJ },
      ], CNPJ)?.id).toBe('cus_000000000009')
    })
    it('empate total (mesmo dia, sem endereço) → o de externalReference nosso', () => {
      expect(pickCustomerForDocument([
        { id: 'cus_1', cpfCnpj: CNPJ, dateCreated: '2026-09-15' },
        { id: 'cus_2', cpfCnpj: CNPJ, dateCreated: '2026-09-15', externalReference: REF },
      ], CNPJ, REF)?.id).toBe('cus_2')
    })
    it('lista vazia ou documento que não é CPF/CNPJ → undefined', () => {
      expect(pickCustomerForDocument([], CNPJ, REF)).toBeUndefined()
      expect(pickCustomerForDocument(null, CNPJ, REF)).toBeUndefined()
      expect(pickCustomerForDocument([{ id: 'cus_1', cpfCnpj: '123' }], '123', REF)).toBeUndefined()
    })
  })

  describe('pickCustomerForReference', () => {
    it('mesmo documento vence o órfão sem documento', () => {
      const orfao = { id: 'cus_1', externalReference: REF, cpfCnpj: null, dateCreated: '2020-01-01' }
      const mesmo = { id: 'cus_2', externalReference: REF, cpfCnpj: CNPJ, dateCreated: '2026-01-01' }
      expect(pickCustomerForReference([orfao, mesmo], REF, CNPJ)?.id).toBe('cus_2')
    })
    it('com documento, devolve o órfão sem documento para adotar', () => {
      expect(pickCustomerForReference([{ id: 'cus_1', externalReference: REF, cpfCnpj: '' }], REF, CNPJ)?.id).toBe('cus_1')
    })
    it('NUNCA devolve cadastro com documento diferente do informado', () => {
      expect(pickCustomerForReference([{ id: 'cus_1', externalReference: REF, cpfCnpj: OUTRO }], REF, CNPJ)).toBeUndefined()
    })
    it('ignora ref diferente e apagado', () => {
      expect(pickCustomerForReference([
        { id: 'cus_1', externalReference: 'outro-contato', cpfCnpj: CNPJ },
        { id: 'cus_2', externalReference: REF, cpfCnpj: CNPJ, deleted: true },
      ], REF, CNPJ)).toBeUndefined()
    })
    it('sem documento informado: prefere quem já tem documento ao órfão', () => {
      const orfao = { id: 'cus_1', externalReference: REF, cpfCnpj: null }
      const comDoc = { id: 'cus_2', externalReference: REF, cpfCnpj: CNPJ }
      expect(pickCustomerForReference([orfao, comDoc], REF, null)?.id).toBe('cus_2')
      expect(pickCustomerForReference([orfao], REF)?.id).toBe('cus_1')
    })
  })
})
