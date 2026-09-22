import { describe, expect, it } from 'vitest'

import { FULL_SCAN_EVERY_MS, reminderWindowFor, upcomingScanPlan } from './upcoming-plan'

const HOJE = '2026-09-22'
const AGORA = Date.UTC(2026, 8, 22, 15, 0, 0)

describe('reminderWindowFor — a janela da fila pelas configurações', () => {
  it('lembrete ligado manda (N dias), mesmo com o aviso do dia junto', () => {
    expect(reminderWindowFor({ reminderDaysBefore: 5, remindOnDueDate: false })).toBe(5)
    expect(reminderWindowFor({ reminderDaysBefore: 5, remindOnDueDate: true })).toBe(5)
  })
  it('só o aviso do dia = só hoje (0); nada ligado = -1', () => {
    expect(reminderWindowFor({ reminderDaysBefore: 0, remindOnDueDate: true })).toBe(0)
    expect(reminderWindowFor({ reminderDaysBefore: 0, remindOnDueDate: false })).toBe(-1)
  })
})

describe('upcomingScanPlan — completa no máximo uma vez por hora, a janela a cada tique', () => {
  const base = { todayKey: HOJE, reminderDaysBefore: 5, remindOnDueDate: false, now: AGORA }

  it('nunca leu (0) → completa até hoje+30', () => {
    const p = upcomingScanPlan({ ...base, lastFullScanAt: 0 })
    expect(p.full).toBe(true)
    expect(p.from).toBe(HOJE)
    expect(p.until).toBe('2026-10-22')
    expect(p.reminderWindow).toBe(5)
  })

  it('leu há 10 min → só a janela (hoje+5), sem completa', () => {
    const p = upcomingScanPlan({ ...base, lastFullScanAt: AGORA - 10 * 60_000 })
    expect(p.full).toBe(false)
    expect(p.until).toBe('2026-09-27')
  })

  it('leu há 1h ou mais → completa de novo', () => {
    expect(upcomingScanPlan({ ...base, lastFullScanAt: AGORA - FULL_SCAN_EVERY_MS }).full).toBe(true)
    expect(upcomingScanPlan({ ...base, lastFullScanAt: AGORA - FULL_SCAN_EVERY_MS + 1 }).full).toBe(false)
  })

  it('force (botão Atualizar) → completa mesmo que tenha lido agora', () => {
    const p = upcomingScanPlan({ ...base, lastFullScanAt: AGORA - 1000, force: true })
    expect(p.full).toBe(true)
    expect(p.until).toBe('2026-10-22')
  })

  it('nada ligado e completa recente → nada a ler (until null)', () => {
    const p = upcomingScanPlan({ ...base, reminderDaysBefore: 0, remindOnDueDate: false, lastFullScanAt: AGORA - 1000 })
    expect(p.reminderWindow).toBe(-1)
    expect(p.until).toBeNull()
  })

  it('nada ligado mas completa vencida → lê o horizonte (a tela continua viva)', () => {
    const p = upcomingScanPlan({ ...base, reminderDaysBefore: 0, remindOnDueDate: false, lastFullScanAt: 0 })
    expect(p.full).toBe(true)
    expect(p.until).toBe('2026-10-22')
  })

  it('só o aviso do dia e completa recente → lê só hoje', () => {
    const p = upcomingScanPlan({ ...base, reminderDaysBefore: 0, remindOnDueDate: true, lastFullScanAt: AGORA - 1000 })
    expect(p.reminderWindow).toBe(0)
    expect(p.until).toBe(HOJE)
  })

  it('janela maior que o horizonte (configuração estranha) → a completa cobre a janela', () => {
    const p = upcomingScanPlan({ ...base, reminderDaysBefore: 45, lastFullScanAt: 0 })
    expect(p.until).toBe('2026-11-06')
  })
})
