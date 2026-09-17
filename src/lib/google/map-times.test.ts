import { describe, it, expect } from 'vitest'

import { zonedIso } from '@/lib/assistant/rules'
import { formatBusySlot } from '@/lib/ai/busy-slots'

// ------------------------------------------------------------
// Evento de DIA INTEIRO vindo do Google é uma data solta ("2026-09-15"),
// não um instante — e o fim é EXCLUSIVO. Antes a data era lida no fuso do
// servidor (UTC no container): em Brasília o compromisso caía um dia antes.
// Foi o que aconteceu com a feira do Renato (Equipotel, 15 a 18/09), que
// apareceu no dia 14 e chegou pra IA como um dia só.
//
// Espelha o mapTimes do sync (que não é exportado) para travar a convenção:
// 00:00 do primeiro dia → 23:59 do último dia COBERTO, no fuso da conta.
// ------------------------------------------------------------

const TZ = 'America/Sao_Paulo'

function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function allDayTimes(startDate: string, endDateExclusive: string, tz = TZ) {
  const lastDay = previousDay(endDateExclusive)
  const endDay = lastDay < startDate ? startDate : lastDay
  return { startsAt: zonedIso(startDate, '00:00', tz), endsAt: zonedIso(endDay, '23:59', tz), allDay: true }
}

const dayInTz = (iso: string, tz = TZ) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  )

describe('dia inteiro do Google → instantes da conta', () => {
  it('não vaza pro dia anterior (o caso Equipotel)', () => {
    const t = allDayTimes('2026-09-15', '2026-09-19')
    expect(dayInTz(t.startsAt)).toBe('2026-09-15')
    expect(dayInTz(t.endsAt)).toBe('2026-09-18')
  })

  it('evento de um dia só cobre exatamente aquele dia', () => {
    const t = allDayTimes('2026-09-16', '2026-09-17')
    expect(dayInTz(t.startsAt)).toBe('2026-09-16')
    expect(dayInTz(t.endsAt)).toBe('2026-09-16')
  })

  it('aguenta fim igual ao início (fim exclusivo mal preenchido)', () => {
    const t = allDayTimes('2026-09-16', '2026-09-16')
    expect(dayInTz(t.startsAt)).toBe('2026-09-16')
    expect(dayInTz(t.endsAt)).toBe('2026-09-16')
  })

  it('vale igual em fuso a leste de Greenwich', () => {
    const t = allDayTimes('2026-09-15', '2026-09-19', 'Europe/Lisbon')
    expect(dayInTz(t.startsAt, 'Europe/Lisbon')).toBe('2026-09-15')
    expect(dayInTz(t.endsAt, 'Europe/Lisbon')).toBe('2026-09-18')
  })
})

describe('como a IA lê esses dias', () => {
  it('feira de 4 dias vira intervalo, não um dia só', () => {
    expect(formatBusySlot(allDayTimes('2026-09-15', '2026-09-19'), TZ)).toBe('ter 15/09 a sex 18/09 (dia todo)')
  })

  it('um dia só continua curto', () => {
    expect(formatBusySlot(allDayTimes('2026-09-16', '2026-09-17'), TZ)).toBe('qua 16/09 (dia todo)')
  })
})
