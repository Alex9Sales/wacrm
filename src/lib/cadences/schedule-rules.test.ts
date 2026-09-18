import { describe, it, expect } from 'vitest'
import { cadenceSendMode, shiftOutOfQuietHours } from './schedule-rules'

const SP = 'America/Sao_Paulo' // UTC−3, sem horário de verão
const iso = (ms: number) => new Date(ms).toISOString()

describe('shiftOutOfQuietHours', () => {
  it('de dia não mexe', () => {
    const ms = Date.parse('2026-09-18T17:00:00Z') // 14h em SP
    expect(shiftOutOfQuietHours(ms, SP)).toBe(ms)
  })

  it('de noite vai pro dia seguinte às 9h', () => {
    // 23h de sexta em SP (02h UTC de sábado) → sábado 9h SP = 12h UTC
    expect(iso(shiftOutOfQuietHours(Date.parse('2026-09-19T02:00:00Z'), SP))).toBe('2026-09-19T12:00:00.000Z')
    // 21h em ponto já é silêncio
    expect(iso(shiftOutOfQuietHours(Date.parse('2026-09-19T00:00:00Z'), SP))).toBe('2026-09-19T12:00:00.000Z')
  })

  it('de madrugada vai pras 9h do mesmo dia', () => {
    // 3h de sábado em SP (06h UTC) → 9h SP = 12h UTC do mesmo dia
    expect(iso(shiftOutOfQuietHours(Date.parse('2026-09-19T06:00:00Z'), SP))).toBe('2026-09-19T12:00:00.000Z')
  })

  it('vira o mês certo', () => {
    // 22h de 30/09 em SP (01h UTC de 01/10) → 01/10 9h SP
    expect(iso(shiftOutOfQuietHours(Date.parse('2026-10-01T01:00:00Z'), SP))).toBe('2026-10-01T12:00:00.000Z')
  })

  it('fuso inválido não quebra', () => {
    const ms = Date.parse('2026-09-19T02:00:00Z')
    expect(shiftOutOfQuietHours(ms, 'Nada/Aqui')).toBe(ms)
  })
})

describe('cadenceSendMode', () => {
  const now = Date.parse('2026-09-18T20:00:00Z')

  it('Meta com janela fechada e modelo → modelo', () => {
    expect(cadenceSendMode({ channelTakesTemplates: true, templateName: 'sem_resposta', lastInboundAt: null, now })).toBe('template')
    expect(
      cadenceSendMode({ channelTakesTemplates: true, templateName: 'x', lastInboundAt: '2026-09-17T19:00:00Z', now }),
    ).toBe('template')
  })

  it('Meta com janela ABERTA → texto (é conversa)', () => {
    expect(
      cadenceSendMode({ channelTakesTemplates: true, templateName: 'x', lastInboundAt: '2026-09-18T10:00:00Z', now }),
    ).toBe('text')
  })

  it('sem modelo, ou canal sem modelo (WAHA) → texto', () => {
    expect(cadenceSendMode({ channelTakesTemplates: true, templateName: null, lastInboundAt: null, now })).toBe('text')
    expect(cadenceSendMode({ channelTakesTemplates: true, templateName: '  ', lastInboundAt: null, now })).toBe('text')
    expect(cadenceSendMode({ channelTakesTemplates: false, templateName: 'x', lastInboundAt: null, now })).toBe('text')
  })
})
