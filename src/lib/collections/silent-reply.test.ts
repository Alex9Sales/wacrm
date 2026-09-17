import { describe, expect, it } from 'vitest'

import { customerTextOf, parseClassification, silentClassifierSystemPrompt } from './silent-reply'

describe('detector silencioso — parse do JSON do modelo', () => {
  it('lê o JSON mesmo com texto em volta e normaliza o tipo', () => {
    expect(parseClassification('Claro: {"kind":"Promessa","date":"2026-09-15"} pronto')).toEqual({ kind: 'promessa', date: '2026-09-15' })
  })
  it('data inválida vira null; tipo desconhecido vira null', () => {
    expect(parseClassification('{"kind":"promessa","date":"segunda"}')).toEqual({ kind: 'promessa', date: null })
    expect(parseClassification('{"kind":"pagou","date":null}')).toBeNull()
    expect(parseClassification('nada de json')).toBeNull()
  })
  it('nenhum é aceito (e o chamador ignora)', () => {
    expect(parseClassification('{"kind":"nenhum","date":null}')).toEqual({ kind: 'nenhum', date: null })
  })
  it('lê about_debt (16/09): true/false quando vem, ausente quando o modelo não diz', () => {
    expect(parseClassification('{"about_debt":false,"kind":"promessa","date":"2026-09-15"}')).toEqual({ kind: 'promessa', date: '2026-09-15', aboutDebt: false })
    expect(parseClassification('{"kind":"acordo","date":null,"about_debt":true}')?.aboutDebt).toBe(true)
    expect(parseClassification('{"kind":"promessa","date":"2026-09-15"}')?.aboutDebt).toBeUndefined()
    // Valor que não é booleano não vira "sobre a dívida".
    expect(parseClassification('{"kind":"promessa","date":null,"about_debt":"sim"}')?.aboutDebt).toBeUndefined()
  })
})

describe('detector silencioso — prompt do classificador (16/09)', () => {
  const p = silentClassifierSystemPrompt('Hoje é segunda-feira, 14/09/2026.')
  it('pede about_debt e data sempre que o cliente citar um dia', () => {
    expect(p).toContain('"about_debt":true|false')
    expect(p).toContain('SEMPRE que o cliente citar um dia')
  })
  it('prazo com dia é promessa, não acordo (WR: "segura até sexta")', () => {
    const acordo = p.split('\n').find((l) => l.startsWith('- acordo:'))!
    // O que é acordo (antes do primeiro ponto) não fala em prazo.
    expect(acordo.split('.')[0]).not.toMatch(/prazo/i)
    expect(acordo).toContain('tirar juros')
    expect(p.split('\n').find((l) => l.startsWith('- promessa:'))).toContain('segura até sexta')
  })
  it('comprovante de outra coisa e mensagem automática são nenhum', () => {
    expect(p).toContain('Pix de terceiro')
    expect(p).toContain('boas-vindas')
  })
})

describe('detector silencioso — texto do cliente', () => {
  it('prefere a transcrição do áudio', () => {
    expect(customerTextOf({ contentText: '[audio]', transcription: 'pago segunda', contentType: 'audio' })).toBe('pago segunda')
  })
  it('placeholder de mídia sem transcrição não classifica', () => {
    expect(customerTextOf({ contentText: '[image]', transcription: null, contentType: 'image' })).toBe('')
    expect(customerTextOf({ contentText: '', transcription: '', contentType: 'text' })).toBe('')
  })
  it('texto normal passa', () => {
    expect(customerTextOf({ contentText: 'já paguei ontem', transcription: null, contentType: 'text' })).toBe('já paguei ontem')
  })
})
