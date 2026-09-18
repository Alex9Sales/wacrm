import { describe, it, expect } from 'vitest'
import { formatMeetingWhen } from './schedule-actions'

describe('formatMeetingWhen', () => {
  it('writes the meeting in the account timezone, whole hour without minutes', () => {
    // 21/09/2026 12:00 UTC = segunda, 9h em Brasília
    expect(formatMeetingWhen('2026-09-21T12:00:00.000Z', 'America/Sao_Paulo')).toBe('segunda-feira, 21/09, às 9h')
  })
  it('keeps the minutes when there are any', () => {
    expect(formatMeetingWhen('2026-09-22T17:30:00.000Z', 'America/Sao_Paulo')).toBe('terça-feira, 22/09, às 14h30')
  })
})
