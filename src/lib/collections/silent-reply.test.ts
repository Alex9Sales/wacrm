import { describe, expect, it } from 'vitest'

import { dayKeyIn, parsePtDates } from './reply-guard'
import { burstAnchor, customerTextOf, parseClassification, silentClassifierSystemPrompt } from './silent-reply'

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
  it('revisão 2: imagem como o inbound grava — descrição em transcription vira [imagem: …], a legenda vem depois', () => {
    expect(customerTextOf({ contentText: '[image]', transcription: 'Comprovante Pix de R$ 150,00', contentType: 'image' })).toBe('[imagem: Comprovante Pix de R$ 150,00]')
    expect(customerTextOf({ contentText: 'segue', transcription: 'Comprovante Pix de R$ 150,00', contentType: 'image' })).toBe('[imagem: Comprovante Pix de R$ 150,00]\nsegue')
    expect(customerTextOf({ contentText: '[document]', transcription: 'Boleto pago', contentType: 'document' })).toBe('[documento: Boleto pago]')
    // Legenda sem descrição (visão desligada) é fala do cliente.
    expect(customerTextOf({ contentText: 'segue comprovante', transcription: null, contentType: 'image' })).toBe('segue comprovante')
  })
})

describe('detector silencioso — "hoje" da rajada (revisão 2)', () => {
  it('ancora no balão mais velho: "pago amanhã" 23:40 e "sem falta" 00:20 leem o mesmo amanhã', () => {
    const bubbles = [{ createdAt: '2026-09-16T23:40:00-03:00' }, { createdAt: '2026-09-17T00:20:00-03:00' }]
    const anchor = burstAnchor(bubbles, new Date('2026-09-17T03:20:00.000Z'))
    expect(dayKeyIn('America/Sao_Paulo', anchor)).toBe('2026-09-16')
    expect(parsePtDates('vou pagar amanhã\nsem falta', dayKeyIn('America/Sao_Paulo', anchor))).toEqual(['2026-09-17'])
  })
  it('sem data legível no balão, usa a reserva', () => {
    const fallback = new Date('2026-09-16T12:00:00.000Z')
    expect(burstAnchor([], fallback)).toBe(fallback)
    expect(burstAnchor([{ createdAt: null }], fallback)).toBe(fallback)
    expect(burstAnchor([{ createdAt: 'lixo' }], fallback)).toBe(fallback)
  })
})
