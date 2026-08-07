import { describe, expect, it } from 'vitest'
import { aiHoursAllows, toAiHoursMode } from './hours-gate'

// Seg–Sex 09:00–18:00 America/Sao_Paulo; sáb/dom fechado.
const OPEN = { open: '09:00', close: '18:00' }
const CLOSED = { open: null, close: null }
const settings = {
  businessHoursEnabled: true,
  businessTimezone: 'America/Sao_Paulo',
  businessDays: [
    CLOSED, // Dom
    OPEN, // Seg
    OPEN,
    OPEN,
    OPEN,
    OPEN, // Sex
    CLOSED, // Sáb
  ],
}

// Terça 14:00 BRT = 17:00Z (dentro). Terça 22:00 BRT = 01:00Z qua (fora).
const insideHours = new Date('2026-08-04T17:00:00Z')
const outsideHours = new Date('2026-08-05T01:00:00Z')
const weekend = new Date('2026-08-09T17:00:00Z') // domingo 14:00 BRT

describe('toAiHoursMode', () => {
  it('normaliza valores', () => {
    expect(toAiHoursMode('inside')).toBe('inside')
    expect(toAiHoursMode('outside')).toBe('outside')
    expect(toAiHoursMode('always')).toBe('always')
    expect(toAiHoursMode(null)).toBe('always')
    expect(toAiHoursMode('lixo')).toBe('always')
  })
})

describe('aiHoursAllows', () => {
  it('always: sempre responde', () => {
    expect(aiHoursAllows('always', settings, insideHours)).toBe(true)
    expect(aiHoursAllows('always', settings, outsideHours)).toBe(true)
  })

  it('inside: só dentro da janela', () => {
    expect(aiHoursAllows('inside', settings, insideHours)).toBe(true)
    expect(aiHoursAllows('inside', settings, outsideHours)).toBe(false)
    expect(aiHoursAllows('inside', settings, weekend)).toBe(false)
  })

  it('outside: só fora da janela (inclui fim de semana)', () => {
    expect(aiHoursAllows('outside', settings, insideHours)).toBe(false)
    expect(aiHoursAllows('outside', settings, outsideHours)).toBe(true)
    expect(aiHoursAllows('outside', settings, weekend)).toBe(true)
  })

  it('fail-open: horário desativado → responde em qualquer modo', () => {
    const off = { ...settings, businessHoursEnabled: false }
    expect(aiHoursAllows('inside', off, insideHours)).toBe(true)
    expect(aiHoursAllows('outside', off, insideHours)).toBe(true)
  })
})
