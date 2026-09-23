import { describe, expect, it } from 'vitest'

import { anyCustomBodyVars, csvNameVars, hasCustomBodyVars } from './recipient-vars'

describe('csvNameVars — o nome da planilha vira saudação', () => {
  it('nome de pessoa: nome completo e primeiro nome', () => {
    expect(csvNameVars('Francinete')).toEqual({ nome: 'Francinete', primeiro_nome: 'Francinete' })
    expect(csvNameVars('Dra. Sabrina Santos')).toEqual({ nome: 'Dra. Sabrina Santos', primeiro_nome: 'Dra. Sabrina' })
  })
  it('nome de empresa: guarda o nome, mas não vira "Olá, Instituto!"', () => {
    expect(csvNameVars('Instituto Talentos')).toEqual({ nome: 'Instituto Talentos' })
    expect(csvNameVars('Clínica Jump')).toEqual({ nome: 'Clínica Jump' })
  })
  it('vazio não gera token nenhum', () => {
    expect(csvNameVars('')).toBeNull()
    expect(csvNameVars(null)).toBeNull()
    expect(csvNameVars('   ')).toBeNull()
  })
})

describe('hasCustomBodyVars — só texto próprio desliga a trava de duplicidade', () => {
  it('nome da planilha NÃO é mensagem própria', () => {
    expect(hasCustomBodyVars({ nome: 'Francinete', primeiro_nome: 'Francinete' })).toBe(false)
    expect(hasCustomBodyVars({ NOME: 'Francinete' })).toBe(false)
  })
  it('{{mensagem}} do Chamar de volta é', () => {
    expect(hasCustomBodyVars({ mensagem: 'oi, sumiu?' })).toBe(true)
    expect(hasCustomBodyVars({ nome: 'Ana', mensagem: 'texto' })).toBe(true)
  })
  it('vazio, null e lixo não contam', () => {
    expect(hasCustomBodyVars(null)).toBe(false)
    expect(hasCustomBodyVars({})).toBe(false)
    expect(hasCustomBodyVars(['x'])).toBe(false)
    expect(hasCustomBodyVars('x')).toBe(false)
  })
  it('anyCustomBodyVars olha o lote inteiro', () => {
    expect(anyCustomBodyVars({ a: { nome: 'Ana' }, b: { nome: 'Bia' } })).toBe(false)
    expect(anyCustomBodyVars({ a: { nome: 'Ana' }, b: { mensagem: 'oi' } })).toBe(true)
    expect(anyCustomBodyVars(undefined)).toBe(false)
  })
})
