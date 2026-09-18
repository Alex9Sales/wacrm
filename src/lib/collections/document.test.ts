import { describe, expect, it } from 'vitest'

import {
  chargeNeedsDocument,
  DOCUMENT_REQUIRED_REASON,
  findDocumentInText,
  isValidCnpj,
  isValidCpf,
  maskDocument,
  normalizeValidDocument,
  pickChargeDocument,
} from './document'

// Exemplos públicos de documentação (não são de ninguém).
const CPF_OK = '529.982.247-25'
const CNPJ_OK = '11.222.333/0001-81'

describe('CPF/CNPJ — validação', () => {
  it('aceita documentos válidos com e sem pontuação', () => {
    expect(isValidCpf(CPF_OK)).toBe(true)
    expect(isValidCpf('52998224725')).toBe(true)
    expect(isValidCnpj(CNPJ_OK)).toBe(true)
    expect(isValidCnpj('11222333000181')).toBe(true)
  })
  it('recusa verificador errado, sequência repetida e tamanho errado', () => {
    expect(isValidCpf('529.982.247-26')).toBe(false)
    expect(isValidCpf('111.111.111-11')).toBe(false)
    expect(isValidCpf('1234567890')).toBe(false)
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false)
    expect(isValidCnpj('00000000000000')).toBe(false)
  })
  it('celular com DDD (11 dígitos) não vira CPF', () => {
    expect(isValidCpf('67990001234')).toBe(false)
    expect(normalizeValidDocument('67 99000-1234')).toBeNull()
    expect(normalizeValidDocument('5567990001234')).toBeNull()
  })
})

describe('findDocumentInText', () => {
  it('acha o documento num balão do dono, com ou sem pontuação', () => {
    expect(findDocumentInText('52998224725')).toBe('52998224725')
    expect(findDocumentInText(`o cpf dele é ${CPF_OK}, pode gerar`)).toBe('52998224725')
    expect(findDocumentInText(`CNPJ ${CNPJ_OK}`)).toBe('11222333000181')
  })
  it('ignora telefone e valores; vazio → null', () => {
    expect(findDocumentInText('manda pro 67 99000-1234, valor 150,00')).toBeNull()
    expect(findDocumentInText('')).toBeNull()
    expect(findDocumentInText(null)).toBeNull()
  })
  it('máscara pra confirmar sem expor', () => {
    expect(maskDocument('52998224725')).toBe('529.***.***-25')
    expect(maskDocument('11222333000181')).toBe('11.222.***/****-81')
  })
})

describe('trava da cobrança (15/09) — chargeNeedsDocument', () => {
  it('produção sem documento exige; com documento ou no sandbox, não', () => {
    expect(chargeNeedsDocument('production', null)).toBe(true)
    expect(chargeNeedsDocument('production', '52998224725')).toBe(false)
    expect(chargeNeedsDocument('sandbox', null)).toBe(false)
  })
  it('ambiente desconhecido conta como produção (falha segura)', () => {
    expect(chargeNeedsDocument('', null)).toBe(true)
    expect(chargeNeedsDocument(null, null)).toBe(true)
    expect(chargeNeedsDocument('prod', '')).toBe(true)
  })
  it('o motivo continua batendo com a regex antiga de "precisa de documento"', () => {
    expect(/CPF ou CNPJ|cpfCnpj/i.test(DOCUMENT_REQUIRED_REASON)).toBe(true)
  })
})

describe('trava da cobrança (15/09) — pickChargeDocument', () => {
  const WALLET = '11222333000181'
  const FIELD = '52998224725'
  it('digitado válido vence carteira e ficha', () => {
    expect(pickChargeDocument({ typed: CPF_OK, wallet: WALLET, customField: FIELD })).toEqual({ doc: '52998224725', source: 'typed', invalidTyped: false })
  })
  it('digitado com verificador errado → inválido e SEM cair no documento conhecido', () => {
    expect(pickChargeDocument({ typed: '529.982.247-26', wallet: WALLET, customField: FIELD })).toEqual({ doc: null, source: null, invalidTyped: true })
    // telefone colado no campo também é inválido
    expect(pickChargeDocument({ typed: '67 99000-1234', wallet: WALLET }).invalidTyped).toBe(true)
  })
  it('sem digitado: carteira antes da ficha', () => {
    expect(pickChargeDocument({ wallet: WALLET, customField: FIELD })).toEqual({ doc: WALLET, source: 'wallet', invalidTyped: false })
    expect(pickChargeDocument({ wallet: null, customField: FIELD })).toEqual({ doc: FIELD, source: 'custom_field', invalidTyped: false })
  })
  it('tudo vazio → sem documento', () => {
    expect(pickChargeDocument({})).toEqual({ doc: null, source: null, invalidTyped: false })
    expect(pickChargeDocument({ typed: null, wallet: '', customField: undefined })).toEqual({ doc: null, source: null, invalidTyped: false })
  })
  it('digitado só com pontuação ou espaço conta como não digitado', () => {
    expect(pickChargeDocument({ typed: ' .-/ ', wallet: WALLET })).toEqual({ doc: WALLET, source: 'wallet', invalidTyped: false })
    expect(pickChargeDocument({ typed: '', customField: FIELD }).source).toBe('custom_field')
  })
})
