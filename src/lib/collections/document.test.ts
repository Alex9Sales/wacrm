import { describe, expect, it } from 'vitest'

import { findDocumentInText, isValidCnpj, isValidCpf, maskDocument, normalizeValidDocument } from './document'

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
    expect(isValidCpf('67991875477')).toBe(false)
    expect(normalizeValidDocument('67 99187-5477')).toBeNull()
    expect(normalizeValidDocument('5567991875477')).toBeNull()
  })
})

describe('findDocumentInText', () => {
  it('acha o documento num balão do dono, com ou sem pontuação', () => {
    expect(findDocumentInText('52998224725')).toBe('52998224725')
    expect(findDocumentInText(`o cpf dele é ${CPF_OK}, pode gerar`)).toBe('52998224725')
    expect(findDocumentInText(`CNPJ ${CNPJ_OK}`)).toBe('11222333000181')
  })
  it('ignora telefone e valores; vazio → null', () => {
    expect(findDocumentInText('manda pro 67 99187-5477, valor 150,00')).toBeNull()
    expect(findDocumentInText('')).toBeNull()
    expect(findDocumentInText(null)).toBeNull()
  })
  it('máscara pra confirmar sem expor', () => {
    expect(maskDocument('52998224725')).toBe('529.***.***-25')
    expect(maskDocument('11222333000181')).toBe('11.222.***/****-81')
  })
})
