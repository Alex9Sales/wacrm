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
