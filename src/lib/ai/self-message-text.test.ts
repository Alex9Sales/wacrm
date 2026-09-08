import { describe, expect, it } from 'vitest'

import { MIN_TEXT_FOR_DB_MATCH, normalizeSelfText, selfMessageFingerprint } from './self-message-text'

const DIGEST = `☀️ Bom dia! Seu resumo da Fluxia — 08/09

💰 Ontem: 0 vendas · R$ 0
📊 Em aberto: R$ 9.815 em 8 negócios`

describe('eco interno — impressão digital do texto', () => {
  it('ignora quebras de linha e espaços a mais (Meta × WAHA entregam diferente)', () => {
    const viaOutroCanal = DIGEST.replace(/\n\n/g, '\n').replace(/ +/g, '  ') + '\n'
    expect(normalizeSelfText(viaOutroCanal)).toBe(normalizeSelfText(DIGEST))
    expect(selfMessageFingerprint(viaOutroCanal)).toBe(selfMessageFingerprint(DIGEST))
  })
  it('texto diferente tem chave diferente (um caractere basta)', () => {
    expect(selfMessageFingerprint(DIGEST)).not.toBe(selfMessageFingerprint(DIGEST.replace('08/09', '09/09')))
  })
  it('vazio normaliza pra vazio (quem envia não grava marcador de nada)', () => {
    expect(normalizeSelfText('  \n ')).toBe('')
  })
  it('o piso do casamento por banco barra "Ok"/"Sim"/"Bom dia" mas não um aviso', () => {
    expect('Bom dia'.length).toBeLessThan(MIN_TEXT_FOR_DB_MATCH)
    expect(normalizeSelfText(DIGEST).length).toBeGreaterThan(MIN_TEXT_FOR_DB_MATCH)
  })
})
