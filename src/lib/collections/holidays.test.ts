import { describe, expect, it } from 'vitest'

import { brazilHolidays, easterSunday, holidayName } from './holidays'

describe('easterSunday — a conta de onde saem Carnaval, Sexta-feira Santa e Corpus Christi', () => {
  it('bate com as Páscoas conhecidas', () => {
    expect(easterSunday(2024).toISOString().slice(0, 10)).toBe('2024-03-31')
    expect(easterSunday(2025).toISOString().slice(0, 10)).toBe('2025-04-20')
    expect(easterSunday(2026).toISOString().slice(0, 10)).toBe('2026-04-05')
    expect(easterSunday(2027).toISOString().slice(0, 10)).toBe('2027-03-28')
  })
})

describe('feriados nacionais', () => {
  it('os fixos de sempre', () => {
    expect(holidayName('2026-12-25')).toBe('Natal')
    expect(holidayName('2026-01-01')).toBe('Confraternização Universal')
    expect(holidayName('2026-09-07')).toBe('Independência')
    expect(holidayName('2026-11-20')).toBe('Consciência Negra')
  })

  it('os que andam com a Páscoa', () => {
    // Páscoa 2026 = 05/04.
    expect(holidayName('2026-04-03')).toBe('Sexta-feira Santa')
    expect(holidayName('2026-02-16')).toBe('Carnaval')
    expect(holidayName('2026-02-17')).toBe('Carnaval')
    expect(holidayName('2026-06-04')).toBe('Corpus Christi')
  })

  it('dia comum não é feriado', () => {
    expect(holidayName('2026-09-11')).toBeNull()
    expect(holidayName('2026-03-10')).toBeNull()
    expect(holidayName('lixo')).toBeNull()
  })

  it('cada ano tem os 13 dias (9 fixos + Carnaval x2 + Sexta Santa + Corpus Christi)', () => {
    expect(brazilHolidays(2026).size).toBe(13)
    expect(brazilHolidays(2027).size).toBe(13)
  })
})
