import { describe, expect, it } from 'vitest'

import { collectionEmail } from './rules'

// 14/09 (João/GoLink): a régua só usava o e-mail do contato — 18 de 30 devedores
// com e-mail no Asaas não recebiam e-mail nenhum. O do Asaas passa a valer.
describe('collectionEmail', () => {
  it('normaliza um endereço válido', () => {
    expect(collectionEmail('  Financeiro@Empresa.com.br ')).toBe('financeiro@empresa.com.br')
  })

  it('lista do Asaas fica com o primeiro válido', () => {
    expect(collectionEmail('a@x.com, b@y.com')).toBe('a@x.com')
    expect(collectionEmail('sem-arroba; contato@loja.com')).toBe('contato@loja.com')
  })

  it('recusa o que não é e-mail', () => {
    expect(collectionEmail('')).toBeNull()
    expect(collectionEmail('fulano')).toBeNull()
    expect(collectionEmail('fulano@')).toBeNull()
    expect(collectionEmail(null)).toBeNull()
    expect(collectionEmail(42)).toBeNull()
  })

  it('pula endereços que voltaram (email_bounces) e fica com o próximo válido', () => {
    const voltou = new Set(['a@x.com'])
    expect(collectionEmail('a@x.com, b@y.com', voltou)).toBe('b@y.com')
    expect(collectionEmail('A@X.com', voltou)).toBeNull()
  })
})
