import { describe, it, expect } from 'vitest'
import { zonedWallToUtc } from './schedule-actions'

describe('zonedWallToUtc', () => {
  it('converte hora de parede de São Paulo (UTC-3) pra UTC', () => {
    // 15:00 em America/Sao_Paulo = 18:00 UTC (sem horário de verão desde 2019).
    const d = zonedWallToUtc('2026-08-16T15:00', 'America/Sao_Paulo')
    expect(d?.toISOString()).toBe('2026-08-16T18:00:00.000Z')
  })

  it('aceita espaço no lugar do T', () => {
    const d = zonedWallToUtc('2026-08-16 09:30', 'America/Sao_Paulo')
    expect(d?.toISOString()).toBe('2026-08-16T12:30:00.000Z')
  })

  it('formato inválido = null', () => {
    expect(zonedWallToUtc('amanhã às 3', 'America/Sao_Paulo')).toBeNull()
  })
})
