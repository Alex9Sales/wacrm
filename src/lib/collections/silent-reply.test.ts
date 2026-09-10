import { describe, expect, it } from 'vitest'

import { customerTextOf, parseClassification } from './silent-reply'

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
