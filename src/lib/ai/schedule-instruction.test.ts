import { describe, expect, it } from 'vitest'

import { scheduleInstruction } from './defaults'
import { ACTION_CATALOG, ORCH_ACTIONS, levelFor, readPolicy } from '@/lib/orchestration/policy'
import { REVERT_MATRIX } from '@/lib/orchestration/revert'

describe('marcar compromisso com aprovação (09/09)', () => {
  it('sem aprovação: confirma na mesma resposta; com aprovação: diz que VAI confirmar e nunca "marcado"', () => {
    expect(scheduleInstruction()).toMatch(/Confirm the agreed day and time ONCE/)
    const a = scheduleInstruction({ approval: true })
    expect(a).toMatch(/must APPROVE/)
    expect(a).toMatch(/NEVER say it is booked/)
    expect(a).toContain('[[AGENDAR:')
  })
  it('schedule_event está no catálogo com padrão "automática" (comportamento de sempre) e tem reversão "Desmarcar"', () => {
    expect(ORCH_ACTIONS).toContain('schedule_event')
    expect(ACTION_CATALOG.schedule_event.defaultLevel).toBe('auto')
    expect(REVERT_MATRIX.schedule_event.kind).toBe('undo')
    expect(levelFor(readPolicy(null), 'schedule_event')).toBe('auto')
    // a matriz grava em `autonomy.actions` (readPolicy aceita esse formato)
    expect(levelFor(readPolicy({ actions: { schedule_event: 'approve' } }), 'schedule_event')).toBe('approve')
  })
})
