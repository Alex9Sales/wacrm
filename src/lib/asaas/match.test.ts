import { describe, expect, it } from 'vitest'

import { asaasPhoneForContact, brPhoneCandidates, daysOverdue, decideMatch, groupDuplicateCustomers, normalizeDocument, normalizeEmail } from './match'

describe('brPhoneCandidates', () => {
  it('acha o mesmo celular gravado com e sem o 55', () => {
    const semDDI = brPhoneCandidates('(67) 99236-1631')
    expect(semDDI).toContain('67992361631')
    expect(semDDI).toContain('5567992361631')

    const comDDI = brPhoneCandidates('5567992361631')
    expect(comDDI).toContain('67992361631')
  })

  it('cobre o 9º dígito nos dois sentidos (número antigo × novo)', () => {
    expect(brPhoneCandidates('6792361631')).toContain('67992361631')
    expect(brPhoneCandidates('67992361631')).toContain('6792361631')
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
    expect(asaasPhoneForContact('67992361631')).toBe('5567992361631')
    expect(asaasPhoneForContact('(67) 99236-1631')).toBe('5567992361631')
    expect(asaasPhoneForContact('6732361631')).toBe('556732361631')
  })

  it('já com 55 fica como está', () => {
    expect(asaasPhoneForContact('+55 67 99236-1631')).toBe('5567992361631')
  })

  it('vazio, curto demais, DDD impossível ou estrangeiro → null (vira pendência, não contato)', () => {
    expect(asaasPhoneForContact('')).toBeNull()
    expect(asaasPhoneForContact(null)).toBeNull()
    expect(asaasPhoneForContact('99236')).toBeNull()
    expect(asaasPhoneForContact('0192361631')).toBeNull()
    expect(asaasPhoneForContact('+370 63949836')).toBeNull()
  })
})

describe('groupDuplicateCustomers — Renato ×3', () => {
  it('agrupa por CPF, e cada cadastro entra em um grupo só', () => {
    const g = groupDuplicateCustomers([
      { id: 'a', name: 'Renato', cpfCnpj: '123.456.789-00', mobilePhone: '67999996855' },
      { id: 'b', name: 'Renato ticolat', cpfCnpj: '12345678900', mobilePhone: '5567999996855' },
      { id: 'c', name: 'Renato T', cpfCnpj: '12345678900', mobilePhone: '6799996855' },
      { id: 'd', name: 'Outra pessoa', cpfCnpj: '98765432100', mobilePhone: '67911112222' },
    ])
    expect(g).toHaveLength(1)
    expect(g[0].by).toBe('cpf')
    expect(g[0].customers.map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('sem CPF, agrupa por telefone tolerando 55 e 9º dígito; e-mail por último', () => {
    const g = groupDuplicateCustomers([
      { id: 'a', name: 'Ana', mobilePhone: '(67) 99236-1631' },
      { id: 'b', name: 'Ana Paula', mobilePhone: '556792361631' },
      { id: 'c', name: 'Beto', email: 'Beto@x.com' },
      { id: 'd', name: 'Roberto', email: 'beto@x.com' },
      { id: 'e', name: 'Solo', email: 'solo@x.com' },
    ])
    expect(g.map((x) => x.by)).toEqual(['phone', 'email'])
    expect(g[0].customers.map((c) => c.id)).toEqual(['a', 'b'])
    expect(g[1].customers.map((c) => c.id)).toEqual(['c', 'd'])
  })
})
