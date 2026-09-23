import { describe, expect, it } from 'vitest'

import { localDayKey } from './stale'

describe('localDayKey', () => {
  it('usa o dia LOCAL da conta, não o UTC', () => {
    // 10/09 23:30 em Campo Grande (UTC-4) = 11/09 03:30 UTC
    const at = new Date('2026-09-11T03:30:00Z')
    expect(localDayKey('America/Campo_Grande', at)).toBe('2026-09-10')
    expect(localDayKey('America/Sao_Paulo', at)).toBe('2026-09-11')
  })

  it('fuso inválido cai no UTC em vez de lançar', () => {
    const at = new Date('2026-09-11T03:30:00Z')
    expect(localDayKey('Marte/Olympus', at)).toBe('2026-09-11')
  })
})

// 22/09: meia-noite de hoje no fuso da conta — "link que já saiu HOJE" do aviso do dia.
import { localDayStartIso } from './stale'

describe('localDayStartIso — meia-noite local em UTC', () => {
  it('São Paulo (UTC-3) e Campo Grande (UTC-4)', () => {
    expect(localDayStartIso('2026-09-22', 'America/Sao_Paulo')).toBe('2026-09-22T03:00:00.000Z')
    expect(localDayStartIso('2026-09-22', 'America/Campo_Grande')).toBe('2026-09-22T04:00:00.000Z')
  })
  it('UTC e leste de Greenwich (Lisboa no verão = UTC+1)', () => {
    expect(localDayStartIso('2026-09-22', 'UTC')).toBe('2026-09-22T00:00:00.000Z')
    expect(localDayStartIso('2026-07-01', 'Europe/Lisbon')).toBe('2026-06-30T23:00:00.000Z')
  })
  it('troca de horário de verão (Nova York: 8/3 ainda EST, 9/3 já EDT)', () => {
    expect(localDayStartIso('2026-03-08', 'America/New_York')).toBe('2026-03-08T05:00:00.000Z')
    expect(localDayStartIso('2026-03-09', 'America/New_York')).toBe('2026-03-09T04:00:00.000Z')
  })
  it('virada de horário de verão à meia-noite (Chile: 6/9 pula de 00:00 para 01:00; 5/4 volta)', () => {
    expect(localDayStartIso('2026-09-06', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z')
    expect(localDayStartIso('2026-04-05', 'America/Santiago')).toBe('2026-04-05T04:00:00.000Z')
  })
  it('fuso inválido → meia-noite UTC; dia inválido → época', () => {
    expect(localDayStartIso('2026-09-22', 'Marte/Cratera')).toBe('2026-09-22T00:00:00.000Z')
    expect(localDayStartIso('x', 'America/Sao_Paulo')).toBe('1970-01-01T00:00:00.000Z')
  })
})
